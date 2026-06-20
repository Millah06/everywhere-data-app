 
import { prisma } from "../../../prisma";
import { identityProvider } from "../../verification/providers/dojah.provider";
import {
  onKycVerified,
  recomputeUserVerification, // (re-exported for symmetry; used by admin path)
} from "../../verification/verification.service";

// Light name-match: the government record's name must reasonably match the
// account name. We skip paid liveness — this is the light-compliance bar.
function nameMatches(
  account: { name?: string | null },
  id: { firstName?: string; lastName?: string },
): boolean {
  const norm = (s?: string | null) =>
    (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const acc = norm(account.name);
  const fn = norm(id.firstName);
  const ln = norm(id.lastName);
  if (!fn || !ln || !acc) return false;
  return acc.includes(fn) && acc.includes(ln);
}

/**
 * POST /kyc/verify
 * Authenticated. Body: { method: "bvn" | "nin", number: string }
 * Synchronous BVN/NIN check via the provider (Dojah). On success: Kyc.status =
 * "verified" (storing only last4 + matched name + provider ref — never the raw
 * number), then verification.service flips vendor L1 + recomputes the badge.
 */
export const verifyIdentity = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const method = String(req.body?.method ?? "").toLowerCase();
    const number = String(req.body?.number ?? "").replace(/\s+/g, "");

    if (method !== "bvn" && method !== "nin") {
      return res.status(400).json({ message: "method must be 'bvn' or 'nin'." });
    }
    if (!/^\d{11}$/.test(number)) {
      return res
        .status(400)
        .json({ message: `${method.toUpperCase()} must be 11 digits.` });
    }

    const existing = await prisma.kyc.findUnique({ where: { userId } });
    if (existing?.status === "verified") {
      return res.status(409).json({ message: "Identity already verified." });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    let result;
    try {
      result =
        method === "nin"
          ? await identityProvider.verifyNin(number)
          : await identityProvider.verifyBvn(number);
    } catch (e: any) {
      if (e?.message === "DOJAH_NOT_CONFIGURED") {
        return res.status(503).json({
          message:
            "Identity verification isn't configured yet. Please try again later.",
        });
      }
      throw e;
    }

    if (!result.ok) {
      await prisma.kyc.upsert({
        where: { userId },
        create: {
          userId,
          status: "rejected",
          method,
          document: { reason: result.error },
        },
        update: { status: "rejected", method, document: { reason: result.error } },
      });
      return res
        .status(400)
        .json({ message: result.error ?? "Verification failed." });
    }

    if (!nameMatches(user ?? {}, result)) {
      return res.status(400).json({
        code: "NAME_MISMATCH",
        message:
          "The name on this ID doesn't match your account. Use your own BVN/NIN, or update your name first.",
      });
    }

    const doc = {
      method,
      last4: number.slice(-4),
      matchedName: `${result.firstName ?? ""} ${result.lastName ?? ""}`.trim(),
    };
    await prisma.kyc.upsert({
      where: { userId },
      create: {
        userId,
        status: "verified",
        method,
        providerRef: result.providerRef ?? null,
        verifiedAt: new Date(),
        document: doc,
      },
      update: {
        status: "verified",
        method,
        providerRef: result.providerRef ?? null,
        verifiedAt: new Date(),
        document: doc,
      },
    });

    // Flip vendor L1 (if any) + recompute the single public badge.
    await onKycVerified(userId);

    return res.json({
      status: "verified",
      message: "Identity verified. You can now cash out and sell on Amril.",
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /kyc
 * Returns KYC status for the authenticated user
 */
export const getKycStatus = async (req: any, res:any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const kyc = await prisma.kyc.findUnique({
      where: { userId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        // Don't expose raw document data to the client
      },
    });

    if (!kyc) {
      return res.json({ status: "unverified", submitted: false });
    }

    return res.json({ ...kyc, submitted: true });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * POST /kyc/submit
 * Submit KYC document for verification.
 * In a real setup this calls a KYC provider (Smile ID, Dojah, etc.)
 * Body: { documentType, documentNumber, documentImageUrl, selfieUrl, dateOfBirth? }
 */
export const submitKyc = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    
    const { documentType, documentNumber, documentImageUrl, selfieUrl, dateOfBirth } = req.body;

    if (!documentType || !documentNumber || !documentImageUrl) {
      return res.status(400).json({
        message: "documentType, documentNumber and documentImageUrl are required.",
      });
    }

    // Allowed document types
    const allowedTypes = ["national_id", "passport", "drivers_license", "voters_card"];
    if (!allowedTypes.includes(documentType)) {
      return res.status(400).json({
        message: `documentType must be one of: ${allowedTypes.join(", ")}`,
      });
    }

    // Check if already verified
    const existing = await prisma.kyc.findUnique({ where: { userId } });
    if (existing?.status === "verified") {
      return res.status(409).json({ message: "KYC is already verified." });
    }
    if (existing?.status === "pending") {
      return res.status(409).json({ message: "KYC is already under review." });
    }

    const kyc = await prisma.kyc.upsert({
      where: { userId },
      create: {
        userId,
        status: "pending",
        document: {
          documentType,
          documentNumber,
          documentImageUrl,
          selfieUrl,
          dateOfBirth,
          submittedAt: new Date().toISOString(),
        },
      },
      update: {
        status: "pending",
        document: {
          documentType,
          documentNumber,
          documentImageUrl,
          selfieUrl,
          dateOfBirth,
          submittedAt: new Date().toISOString(),
        },
      },
      select: { id: true, status: true, updatedAt: true },
    });

    // 🔌 TODO: Call your KYC provider here (Smile ID / Dojah / YouVerify)
    // and use a webhook to transition status to "verified" or "rejected"

    return res.status(201).json({
      ...kyc,
      message: "KYC submitted successfully. Verification usually takes 24–48 hours.",   
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default {
    getKycStatus,
    submitKyc,
    verifyIdentity,
}
