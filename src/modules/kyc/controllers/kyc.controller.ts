 
import { prisma } from "../../../prisma";

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
}