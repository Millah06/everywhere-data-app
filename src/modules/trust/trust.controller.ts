// src/modules/trust/trust.controller.ts
//
// PHASE 4 — Merchant Trust System (backend)
// ─────────────────────────────────────────────────────────────────────────────
// Vendor-facing:
//   GET  /vendor/trust/status            → getTrustStatus
//   POST /vendor/trust/submit-identity   → submitIdentity   (multer, auto L0→L1)
//   POST /vendor/trust/pay-fee           → payVerificationFee (₦2,500 wallet debit)
//   (CAC upload reuses the existing POST /vendor/upload/cac flow.)
// Admin-facing (mounted in src/modules/admin/routes/routes.ts):
//   GET  /admin/trust/pending            → getPendingTrust
//   POST /admin/trust/:vendorId/approve  → approveTrust
//   POST /admin/trust/:vendorId/reject   → rejectTrust
//
// Level model (spec §11):
//   0 Unverified — cannot sell.
//   1 Identity   — manual KYC, AUTO-APPROVED when a valid identity doc is sent.
//   2 Trusted    — automatic (nightly cron): 50+ completed orders, <5% disputes,
//                  account age 60+ days. (Computed here, persisted by the cron.)
//   3 Business   — L2 + CAC on file + ₦2,500 fee (non-refundable) + 200+ orders +
//                  <2% disputes + ADMIN approval. Approval also flips the legacy
//                  Vendor.verified blue badge so existing badge logic still works.
//
// All wallet money movement reuses WalletService (Fiat balance is source of
// truth). The ₦2,500 fee is debited at REQUEST time and is non-refundable on
// rejection (spec business rule).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../../prisma";
import {
  recomputeUserVerification,
  onKycVerified,
} from "../verification/verification.service";
import admin from "firebase-admin";
import { uploadImage } from "../../shared/services/uploadImage.service";
import { WalletService } from "../../shared/services/wallet.service";
import { TX_TYPE } from "../../shared/utils/transactionType";
import {
  rulesForLevel,
  settlementDelayHoursForDb,
  dailyWithdrawalLimitForDb,
  UNLIMITED_DAILY_LIMIT,
  ensureTrustProfile,
} from "../marketPlace/settlement/settlement.rules";
import {
  buildTrustLevelCatalog,
  buildCatalogPreview,
  getCatalogDefaults,
  sanitizeCatalogOverrides,
  type CatalogOverrides,
  type CatalogThresholds,
} from "./trust.catalog";

// Fee for Level 3 (Business) verification, in Naira.
const VERIFICATION_FEE = 2500;

// Level-2 (Trusted) auto-upgrade thresholds.
export const L2_MIN_COMPLETED_ORDERS = 50;
export const L2_MAX_DISPUTE_RATE = 5; // percent
export const L2_MIN_ACCOUNT_AGE_DAYS = 60;

// Level-3 (Business) thresholds (admin still has the final say).
export const L3_MIN_COMPLETED_ORDERS = 200;
export const L3_MAX_DISPUTE_RATE = 2; // percent

// Single thresholds object reused by serializeProfile + the admin catalog
// endpoints, so the numbers shown to merchants never diverge from the gating.
const TRUST_THRESHOLDS: CatalogThresholds = {
  l2MinCompletedOrders: L2_MIN_COMPLETED_ORDERS,
  l2MaxDisputeRate: L2_MAX_DISPUTE_RATE,
  l2MinAccountAgeDays: L2_MIN_ACCOUNT_AGE_DAYS,
  l3MinCompletedOrders: L3_MIN_COMPLETED_ORDERS,
  l3MaxDisputeRate: L3_MAX_DISPUTE_RATE,
  verificationFee: VERIFICATION_FEE,
};

const LEVEL_LABELS: Record<number, string> = {
  0: "Unverified",
  1: "Identity Verified",
  2: "Trusted Merchant",
  3: "Business Verified",
};

const notify = async (token: string | null | undefined, title: string, body: string) => {
  if (!token) return;
  const { sendNotification } = await import("../../shared/utils/notification");
  await sendNotification(token, title, body);
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared computation (also imported by trust.cron.ts so the rules never diverge)
// ─────────────────────────────────────────────────────────────────────────────

export interface VendorTrustStats {
  totalCompletedOrders: number;
  totalOrders: number;
  appealedOrders: number;
  /** appealed / total, as a percentage (0–100). 0 when there are no orders. */
  disputeRatePercent: number;
  accountAgeDays: number;
}

/**
 * Compute the live trust statistics for a vendor from its orders + age.
 * Dispute rate = appealed orders / total orders (spec §11).
 */
export async function computeVendorTrustStats(
  vendorId: string,
): Promise<VendorTrustStats> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { createdAt: true, totalCompletedOrders: true },
  });

  const orders = await prisma.order.findMany({
    where: { vendorId },
    select: { status: true },
  });

  const totalOrders = orders.length;
  const completed = orders.filter((o) => o.status === "completed").length;
  const appealed = orders.filter((o) => o.status === "appealed").length;
  const disputeRatePercent =
    totalOrders > 0 ? (appealed / totalOrders) * 100 : 0;

  const createdAt = vendor?.createdAt ?? new Date();
  const accountAgeDays = Math.floor(
    (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24),
  );

  return {
    // Prefer the live count; fall back to the cached vendor counter.
    totalCompletedOrders: completed || vendor?.totalCompletedOrders || 0,
    totalOrders,
    appealedOrders: appealed,
    disputeRatePercent,
    accountAgeDays,
  };
}

export function meetsLevel2(stats: VendorTrustStats): boolean {
  return (
    stats.totalCompletedOrders >= L2_MIN_COMPLETED_ORDERS &&
    stats.disputeRatePercent < L2_MAX_DISPUTE_RATE &&
    stats.accountAgeDays >= L2_MIN_ACCOUNT_AGE_DAYS
  );
}

export function meetsLevel3Performance(stats: VendorTrustStats): boolean {
  return (
    stats.totalCompletedOrders >= L3_MIN_COMPLETED_ORDERS &&
    stats.disputeRatePercent < L3_MAX_DISPUTE_RATE
  );
}

/** Write a level onto a profile and keep settlement/limit columns in sync. */
async function applyLevel(vendorId: string, level: number) {
  return prisma.merchantTrustProfile.update({
    where: { vendorId },
    data: {
      level,
      settlementDelayHours: settlementDelayHoursForDb(level),
      dailyWithdrawalLimit: dailyWithdrawalLimitForDb(level),
    },
  });
}

// Build the "requirements checklist" the Flutter page renders for the next level.
function nextLevelRequirements(
  profile: { level: number; cacVerified: boolean; verificationFeePaid: boolean },
  stats: VendorTrustStats,
  hasCacDoc: boolean,
  emailVerified: boolean = false,
) {
  if (profile.level === 0) {
    return {
      level: 1,
      pendingAdminReview: false,
      requirements: [
        { key: "identity", label: "Submit a valid government ID", met: false },
      ],
    };
  }
  if (profile.level === 1) {
    return {
      level: 2,
      pendingAdminReview: false,
      requirements: [
        {
          key: "email",
          label: "Verify your email address",
          met: emailVerified,
        },
        {
          key: "orders",
          label: "Complete 50 orders",
          met: stats.totalCompletedOrders >= L2_MIN_COMPLETED_ORDERS,
          current: stats.totalCompletedOrders,
          target: L2_MIN_COMPLETED_ORDERS,
        },
        {
          key: "disputes",
          label: "Keep disputes under 5%",
          met: stats.disputeRatePercent < L2_MAX_DISPUTE_RATE,
          current: Math.round(stats.disputeRatePercent * 10) / 10,
          target: L2_MAX_DISPUTE_RATE,
        },
        {
          key: "age",
          label: "60 days on the platform",
          met: stats.accountAgeDays >= L2_MIN_ACCOUNT_AGE_DAYS,
          current: stats.accountAgeDays,
          target: L2_MIN_ACCOUNT_AGE_DAYS,
        },
      ],
    };
  }
  if (profile.level === 2) {
    return {
      level: 3,
      pendingAdminReview: false,
      requirements: [
        {
          key: "orders",
          label: "Complete 200 orders",
          met: stats.totalCompletedOrders >= L3_MIN_COMPLETED_ORDERS,
          current: stats.totalCompletedOrders,
          target: L3_MIN_COMPLETED_ORDERS,
        },
        {
          key: "disputes",
          label: "Keep disputes under 2%",
          met: stats.disputeRatePercent < L3_MAX_DISPUTE_RATE,
          current: Math.round(stats.disputeRatePercent * 10) / 10,
          target: L3_MAX_DISPUTE_RATE,
        },
        { key: "cac", label: "Upload business documents", met: hasCacDoc },
        { key: "admin", label: "Admin review & approval", met: false },
      ],
    };
  }
  return null; // already level 3
}

function serializeProfile(
  profile: any,
  stats: VendorTrustStats,
  hasCacDoc: boolean,
  pendingRequest: any | null,
  catalogOverrides: CatalogOverrides | null = null,
  vendor?: any,
  emailVerified: boolean = false,
) {
  const rule = rulesForLevel(profile.level);
  const next = nextLevelRequirements(profile, stats, hasCacDoc, emailVerified);
  if (next && pendingRequest && pendingRequest.toLevel === next.level) {
    next.pendingAdminReview = pendingRequest.status === "pending";
  }

  // Full 0→3 catalog so the app can show a comparison of EVERY level's
  // requirements + benefits, with this merchant's progress ticked against each.
  // Single source of truth lives in trust.catalog.ts (admin-overridable).
  const levels = buildTrustLevelCatalog(
    {
      currentLevel: profile.level,
      totalCompletedOrders: stats.totalCompletedOrders,
      disputeRatePercent: stats.disputeRatePercent,
      accountAgeDays: stats.accountAgeDays,
      hasCacDocument: hasCacDoc,
      verificationFeePaid: profile.verificationFeePaid,
    },
    TRUST_THRESHOLDS,
    catalogOverrides,
  );

  return {
    levels,
    level: profile.level,
    levelLabel: LEVEL_LABELS[profile.level] ?? "Unverified",
    canSell: rule.canSell,
    settlementDelayHours: profile.settlementDelayHours,
    dailyWithdrawalLimit: profile.dailyWithdrawalLimit,
    dailyWithdrawalUnlimited:
      profile.dailyWithdrawalLimit >= UNLIMITED_DAILY_LIMIT,
    identityVerified: profile.identityVerified,
    faceVerified: profile.faceVerified,
    phoneVerified: profile.phoneVerified,
    cacVerified: profile.cacVerified,
    hasCacDocument: hasCacDoc,
    verificationFeePaid: profile.verificationFeePaid,
    emailVerified,
    adminApproved: profile.adminApproved,
    adminReviewNote: profile.adminReviewNote ?? null,
    identityDocumentUrl: profile.identityDocumentUrl ?? null,
    verificationFee: VERIFICATION_FEE,
    cacCertificateUrl: vendor?.cacCertificateUrl ?? null,
    businessDocuments: vendor?.businessDocuments ?? null,
    stats,
    nextLevel: next,
    pendingRequest: pendingRequest
      ? { toLevel: pendingRequest.toLevel, status: pendingRequest.status }
      : null,
  };
}

// Resolve the vendor owned by the calling user, or null.
async function vendorForUser(userId: string) {
  return prisma.vendor.findFirst({ where: { ownerId: userId } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendor endpoints
// ─────────────────────────────────────────────────────────────────────────────

const getTrustStatus = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const vendor = await vendorForUser(userId);
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const profile = await ensureTrustProfile(vendor.id);
    const stats = await computeVendorTrustStats(vendor.id);
    const hasCacDoc = !!(vendor.cacCertificateUrl || (vendor as any).businessDocuments);

    const userRecord = await prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true },
    });
    const emailVerified = userRecord?.emailVerified ?? false;

    const pendingRequest = await prisma.trustLevelUpgradeRequest.findFirst({
      where: { vendorId: vendor.id, status: "pending" },
      orderBy: { createdAt: "desc" },
    });

    // Optional admin-edited overrides (no app release needed). Reads
    // AppConfig.trustCatalog if that column exists; otherwise null → defaults.
    // Defensive: a missing column simply yields undefined, never throws.
    let overrides: CatalogOverrides | null = null;
    try {
      const cfg = await prisma.appConfig.findFirst();
      overrides = ((cfg as any)?.trustCatalog as CatalogOverrides) ?? null;
    } catch {
      overrides = null;
    }

    res.json(
      serializeProfile(profile, stats, hasCacDoc, pendingRequest, overrides, vendor, emailVerified),
    );
  } catch (e: any) {
    // Most likely cause pre-migration: trust tables not present yet.
    res.status(400).json({ message: e.message });
  }
};

// L0 → L1. Manual KYC, auto-approved when a valid identity document is supplied
// (spec business rule: "0→1 manual KYC (auto-approve if valid)").
//
// NOTE / deviation: real face-match and phone-OTP are out of this phase's scope.
// We treat a submitted ID document as satisfying identity + face for manual
// review, and derive phoneVerified from the user's stored phone. Hooks are left
// for a future face/OTP integration (faceVerified / phoneVerified flags).
// const submitIdentity = async (req: any, res: any) => {
//   try {
//     const userId = req.user?.id;
//     if (!req.file)
//       return res.status(400).json({ message: "No identity document provided" });

//     const vendor = await vendorForUser(userId);
//     if (!vendor) return res.status(404).json({ message: "Vendor not found" });

//     await ensureTrustProfile(vendor.id);

//     const documentUrl = await uploadImage(req.file, userId, "identityDocument");

//     const user = await prisma.user.findUnique({
//       where: { id: userId },
//       select: { phone: true, notificationToken: true },
//     });
//     const phoneVerified = !!(user?.phone && user.phone.trim().length > 0);

//     // Auto-approve to level 1.
//     const updated = await prisma.merchantTrustProfile.update({
//       where: { vendorId: vendor.id },
//       data: {
//         identityDocumentUrl: documentUrl,
//         identityVerified: true,
//         faceVerified: true, // document stands in for face/liveness in this phase
//         phoneVerified,
//         level: 1,
//         settlementDelayHours: settlementDelayHoursForDb(1),
//         dailyWithdrawalLimit: dailyWithdrawalLimitForDb(1),
//       },
//     });

//     await notify(
//       user?.notificationToken,
//       "IDENTITY VERIFIED",
//       "Your identity has been verified. You can now sell on Amril.",
//     );

//     const stats = await computeVendorTrustStats(vendor.id);
//     res.json(serializeProfile(updated, stats, !!vendor.cacCertificateUrl, null));
//   } catch (e: any) {
//     res.status(400).json({ message: e.message });
//   }
// };

// L0 → L1 (Identity). Phase 13: identity is proven ONCE at the user level
// (BVN/NIN). A vendor reaches Level 1 only when the owner's Kyc is verified —
// no auto-approve on an uploaded image, no fake face/phone flags. The doc upload
// that used to live here is gone; the body is ignored.
const submitIdentity = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const vendor = await vendorForUser(userId);
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    await ensureTrustProfile(vendor.id);

    // Gate Level 1 on REAL identity verification.
    const kyc = await prisma.kyc.findUnique({
      where: { userId },
      select: { status: true },
    });

    if (kyc?.status !== "verified") {
      return res.status(400).json({
        code: "KYC_REQUIRED",
        message:
          "Verify your identity first (BVN or NIN) to start selling. Open Identity Verification in your wallet.",
      });
    }

    // Flip Level 1 (with a real phoneVerified) + recompute the owner's badge.
    await onKycVerified(userId);

    const profile = await prisma.merchantTrustProfile.findUnique({
      where: { vendorId: vendor.id },
    });
    const stats = await computeVendorTrustStats(vendor.id);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { notificationToken: true },
    });
    await notify(
      user?.notificationToken,
      "IDENTITY VERIFIED",
      "Your identity is verified. You can now sell on Amril.",
    );

    res.json(
      serializeProfile(profile!, stats, !!vendor.cacCertificateUrl, null),
    );
  } catch (e: any) {
    res.status(400).json({ message: e.message });
  }
};

// L2 → L3 request. Debits the non-refundable ₦2,500 fee, records CAC on file,
// and opens an admin review request. CAC document itself is uploaded separately
// via the existing POST /vendor/upload/cac route (sets Vendor.cacCertificateUrl).
// const payVerificationFee = async (req: any, res: any) => {
//   try {
//     const userId = req.user?.id;
//     const { clientRequestId } = req.body ?? {};

//     const vendor = await vendorForUser(userId);
//     if (!vendor) return res.status(404).json({ message: "Vendor not found" });

//     const profile = await ensureTrustProfile(vendor.id);

//     if (profile.level < 2) {
//       return res.status(400).json({
//         message: "You must reach Trusted (level 2) before upgrading to Business.",
//       });
//     }
//     if (profile.level >= 3) {
//       return res.status(400).json({ message: "Already Business verified." });
//     }
//     if (!vendor.cacCertificateUrl) {
//       return res
//         .status(400)
//         .json({ message: "Upload your CAC certificate before paying the fee." });
//     }
//     if (profile.verificationFeePaid) {
//       return res
//         .status(400)
//         .json({ message: "Verification fee already paid; awaiting review." });
//     }

//     // Debit the fee (idempotent if a clientRequestId is supplied). Throws
//     // "Insufficient balance" if the wallet can't cover it.
//     await WalletService.chargeWalletForFee({
//       userId,
//       amount: VERIFICATION_FEE,
//       type: TX_TYPE.VERIFICATION_FEE,
//       clientRequestId,
//       metaData: {
//         productName: "Business Verification Fee",
//         vendorId: vendor.id,
//         nonRefundable: true,
//       },
//     });

//     const updated = await prisma.merchantTrustProfile.update({
//       where: { vendorId: vendor.id },
//       data: { verificationFeePaid: true, cacVerified: true },
//     });

//     // Open / refresh the admin review request.
//     const existing = await prisma.trustLevelUpgradeRequest.findFirst({
//       where: { vendorId: vendor.id, toLevel: 3, status: "pending" },
//     });
//     if (!existing) {
//       await prisma.trustLevelUpgradeRequest.create({
//         data: { vendorId: vendor.id, toLevel: 3, status: "pending" },
//       });
//     }

//     await admin.firestore().collection("adminNotifications").add({
//       type: "TRUST_UPGRADE_REQUEST",
//       vendorId: vendor.id,
//       vendorName: vendor.name,
//       toLevel: 3,
//       createdAt: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     const stats = await computeVendorTrustStats(vendor.id);
//     const pending = await prisma.trustLevelUpgradeRequest.findFirst({
//       where: { vendorId: vendor.id, status: "pending" },
//       orderBy: { createdAt: "desc" },
//     });
//     res.json({
//       message:
//         "Payment received. Your Business verification is now under review (1–3 business days).",
//       ...serializeProfile(updated, stats, true, pending),
//     });
//   } catch (e: any) {
//     res.status(400).json({ message: e.message });
//   }
// };

// L2 → L3 request. Phase 13: the ₦2,500 fee is DORMANT (off by default). It
// remains in code as a growth lever — flip AppConfig.businessFeeEnabled = true
// to charge again. While off, this just records CAC + opens the admin review.
const payVerificationFee = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { clientRequestId } = req.body ?? {};

    const vendor = await vendorForUser(userId);
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const profile = await ensureTrustProfile(vendor.id);

    // Is the fee switched on?
    let feeEnabled = false;
    try {
      const cfg = await prisma.appConfig.findFirst();
      feeEnabled = !!(cfg as any)?.businessFeeEnabled;
    } catch {
      feeEnabled = false;
    }

    if (profile.level < 2) {
      return res.status(400).json({
        message:
          "You must reach Trusted (level 2) before upgrading to Business.",
      });
    }
    if (profile.level >= 3) {
      return res.status(400).json({ message: "Already Business verified." });
    }
    if (!vendor.cacCertificateUrl && !(vendor as any).businessDocuments) {
      return res.status(400).json({
        message:
          "Upload your business documents before requesting Business verification.",
      });
    }
    if (feeEnabled && profile.verificationFeePaid) {
      return res
        .status(400)
        .json({ message: "Verification fee already paid; awaiting review." });
    }

    // Charge ONLY when the fee is enabled.
    if (feeEnabled) {
      await WalletService.chargeWalletForFee({
        userId,
        amount: VERIFICATION_FEE,
        type: TX_TYPE.VERIFICATION_FEE,
        clientRequestId,
        metaData: {
          productName: "Business Verification Fee",
          vendorId: vendor.id,
          nonRefundable: true,
        },
      });
    }

    const updated = await prisma.merchantTrustProfile.update({
      where: { vendorId: vendor.id },
      data: { verificationFeePaid: feeEnabled, cacVerified: true },
    });

    const existing = await prisma.trustLevelUpgradeRequest.findFirst({
      where: { vendorId: vendor.id, toLevel: 3, status: "pending" },
    });
    if (!existing) {
      await prisma.trustLevelUpgradeRequest.create({
        data: { vendorId: vendor.id, toLevel: 3, status: "pending" },
      });
    }

    await admin.firestore().collection("adminNotifications").add({
      type: "TRUST_UPGRADE_REQUEST",
      vendorId: vendor.id,
      vendorName: vendor.name,
      toLevel: 3,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const stats = await computeVendorTrustStats(vendor.id);
    const pending = await prisma.trustLevelUpgradeRequest.findFirst({
      where: { vendorId: vendor.id, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      message: feeEnabled
        ? "Payment received. Your Business verification is now under review (1–3 business days)."
        : "Request received. Your Business verification is now under review (1–3 business days).",
      ...serializeProfile(updated, stats, true, pending),
    });
  } catch (e: any) {
    res.status(400).json({ message: e.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin endpoints (requireAdmin in the route layer)
// ─────────────────────────────────────────────────────────────────────────────

const getPendingTrust = async (req: any, res: any) => {
  try {
    const requests = await prisma.trustLevelUpgradeRequest.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
    });

    // Join the vendor + its profile + live stats for the admin review screen.
    const detailed = await Promise.all(
      requests.map(async (r) => {
        const vendor = await prisma.vendor.findUnique({
          where: { id: r.vendorId },
          select: {
            id: true,
            name: true,
            logo: true,
            email: true,
            phone: true,
            cacCertificateUrl: true,
            verified: true,
          },
        });
        const profile = await prisma.merchantTrustProfile.findUnique({
          where: { vendorId: r.vendorId },
        });
        const stats = await computeVendorTrustStats(r.vendorId);
        return {
          requestId: r.id,
          toLevel: r.toLevel,
          status: r.status,
          createdAt: r.createdAt,
          vendor,
          profile,
          stats,
          meetsPerformance: meetsLevel3Performance(stats),
        };
      }),
    );

    res.json(detailed);
  } catch (e: any) {
    res.status(400).json({ message: e.message });
  }
};

const approveTrust = async (req: any, res: any) => {
  try {
    const { vendorId } = req.params;
    const { note, toLevel } = req.body ?? {};
    const targetLevel = Number(toLevel ?? 3);

    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      include: { user: { select: { notificationToken: true } } },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    await ensureTrustProfile(vendorId);

    const profile = await prisma.merchantTrustProfile.update({
      where: { vendorId },
      data: {
        level: targetLevel,
        settlementDelayHours: settlementDelayHoursForDb(targetLevel),
        dailyWithdrawalLimit: dailyWithdrawalLimitForDb(targetLevel),
        adminApproved: true,
        adminReviewNote: note ?? null,
        adminReviewedAt: new Date(),
        adminReviewedBy: req.user?.id ?? null,
      },
    });

    // Reconcile the legacy blue-badge flow: Business (L3) == verified merchant.
    // if (targetLevel >= 3) {
    //   await prisma.vendor.update({
    //     where: { id: vendorId },
    //     data: { verified: true, verificationStatus: "verified" },
    //   });
    // }

    // Phase 13: a Business (L3) vendor's owner now qualifies for the single
    // public "Verified" badge (kyc + business). Recompute from the one source.
    if (targetLevel >= 3) {
      await recomputeUserVerification(vendor.ownerId);
    }

    await prisma.trustLevelUpgradeRequest.updateMany({
      where: { vendorId, status: "pending" },
      data: { status: "approved", adminNote: note ?? null },
    });

    await notify(
      vendor.user.notificationToken,
      "BUSINESS VERIFICATION APPROVED",
      "Your store is now Business Verified. The blue badge is live and settlements are instant.",
    );

    res.json({ message: "Approved", profile });
  } catch (e: any) {
    res.status(400).json({ message: e.message });
  }
};

const rejectTrust = async (req: any, res: any) => {
  try {
    const { vendorId } = req.params;
    const { note } = req.body ?? {};

    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      include: { user: { select: { notificationToken: true } } },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    await ensureTrustProfile(vendorId);

    // Fee is NON-REFUNDABLE on rejection (business rule). We clear the paid flag
    // so the merchant must re-pay if they re-apply, but we do NOT refund.
    await prisma.merchantTrustProfile.update({
      where: { vendorId },
      data: {
        adminApproved: false,
        adminReviewNote: note ?? "Application did not meet our criteria.",
        adminReviewedAt: new Date(),
        adminReviewedBy: req.user?.id ?? null,
        verificationFeePaid: false,
      },
    });

    await prisma.trustLevelUpgradeRequest.updateMany({
      where: { vendorId, status: "pending" },
      data: { status: "rejected", adminNote: note ?? null },
    });

    await notify(
      vendor.user.notificationToken,
      "VERIFICATION UPDATE",
      "Your Business verification could not be approved at this time. Check the app for details.",
    );

    res.json({ message: "Rejected" });
  } catch (e: any) {
    res.status(400).json({ message: e.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin: trust level catalog (runtime-editable copy, no app release)
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/trust/catalog — returns the editable defaults, the current saved
// overrides, and the effective (merged) copy so an admin UI can render a form.
const getTrustCatalog = async (_req: any, res: any) => {
  try {
    let overrides: CatalogOverrides = {};
    try {
      const cfg = await prisma.appConfig.findFirst();
      overrides = sanitizeCatalogOverrides((cfg as any)?.trustCatalog ?? {});
    } catch {
      overrides = {};
    }

    res.json({
      defaults: getCatalogDefaults(TRUST_THRESHOLDS), // pre-fill / reset target
      overrides, // what's currently saved
      effective: buildCatalogPreview(TRUST_THRESHOLDS, overrides), // what merchants see (copy)
      thresholds: TRUST_THRESHOLDS, // numbers live in code (changing them is a deploy)
    });
  } catch (e: any) {
    res.status(400).json({ message: e.message });
  }
};

// PUT /admin/trust/catalog — save overrides. Body may be the overrides object
// directly, or { trustCatalog: {...} }. Anything invalid is stripped. Send {}
// (or { trustCatalog: {} }) to reset back to the code defaults.
const updateTrustCatalog = async (req: any, res: any) => {
  try {
    const raw = req.body?.trustCatalog ?? req.body ?? {};
    const clean = sanitizeCatalogOverrides(raw);

    const cfg = await prisma.appConfig.findFirst();
    if (!cfg) {
      // AppConfig is a singleton; create it if an admin hasn't seeded it yet.
      await prisma.appConfig.create({ data: { trustCatalog: clean } as any });
    } else {
      await prisma.appConfig.update({
        where: { id: cfg.id },
        data: { trustCatalog: clean } as any,
      });
    }

    res.json({
      message: "Trust catalog updated.",
      overrides: clean,
      effective: buildCatalogPreview(TRUST_THRESHOLDS, clean),
    });
  } catch (e: any) {
    res.status(400).json({ message: e.message });
  }
};

export default {
  getTrustStatus,
  submitIdentity,
  payVerificationFee,
  getPendingTrust,
  approveTrust,
  rejectTrust,
  getTrustCatalog,
  updateTrustCatalog,
};