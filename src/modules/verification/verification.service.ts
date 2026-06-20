// src/modules/verification/verification.service.ts
//
// PHASE 13 — Verification (single source of truth)
// ─────────────────────────────────────────────────────────────────────────────
// This service is the ONLY place that decides two things:
//
//   1. UserProfile.isVerified  — the ONE public "Verified" badge (profile + posts
//      + list tiles). Rule:  isVerified = kycVerified AND (businessVendor OR adminGranted)
//        • kycVerified   = Kyc.status === "verified"        (BVN/NIN — Pass 2)
//        • businessVendor = owns a vendor at trust level 3  (CAC + admin approved)
//        • adminGranted   = UserProfile.adminVerified        (manual, rare)
//      KYC alone is NEVER enough — it's a capability (cash-out), not a badge.
//
//   2. MerchantTrustProfile.level 1 ("Identity") — a vendor reaches L1 when, and
//      only when, the OWNER's KYC is verified. No auto-approve on an uploaded
//      image, no fake face/phone flags. Because the same human owns the account
//      and the vendor, identity is proven once (at the user level) and read here.
//
// Nothing else should write UserProfile.isVerified or set level 1 directly.
// Keeping it centralised is what stops the six-flags-that-disagree problem.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../../prisma";
import {
  ensureTrustProfile,
  settlementDelayHoursForDb,
  dailyWithdrawalLimitForDb,
} from "../marketPlace/settlement/settlement.rules";

/**
 * Recompute and persist the single public "Verified" badge for one user.
 * Idempotent and cheap — safe to call after any event that could change the
 * inputs (KYC verified, vendor reaches Business, admin grants/revokes).
 *
 * Returns the resolved value (also written to UserProfile.isVerified).
 */
export async function recomputeUserVerification(
  userId: string,
): Promise<boolean> {
  if (!userId) return false;

  // 1. KYC (identity) — the capability gate. Necessary, not sufficient.
  const kyc = await prisma.kyc.findUnique({
    where: { userId },
    select: { status: true },
  });
  const kycVerified = kyc?.status === "verified";

  // 2. The user's profile row (home of the flag + the admin-grant input).
  const profile = await prisma.userProfile.findUnique({
    where: { userId },
    select: { isVerified: true, adminVerified: true },
  });
  // No profile row → nowhere to store the badge. Nothing to do.
  if (!profile) return false;

  // 3. Business standing — does this user own a Business-level (L3) vendor?
  //    `is` filters the optional 1-1 trust relation safely.
  const businessVendor = await prisma.vendor.findFirst({
    where: { ownerId: userId, trustProfile: { is: { level: 3 } } },
    select: { id: true },
  });

  // The one rule.
  const shouldBeVerified =
    kycVerified && (!!businessVendor || profile.adminVerified === true);

  // Only write when it actually changes (keeps updatedAt / churn minimal).
  if (profile.isVerified !== shouldBeVerified) {
    await prisma.userProfile.update({
      where: { userId },
      data: { isVerified: shouldBeVerified },
    });
  }

  return shouldBeVerified;
}

/**
 * Call this the moment a user's KYC transitions to "verified" (Pass 2 wires it
 * into the Dojah result handler). It:
 *   • flips the owner's vendor to Level 1 (Identity) if they have a vendor and
 *     are still below L1 — with a REAL phoneVerified (the BVN/NIN lookup already
 *     confirmed the registered phone), and
 *   • recomputes the public badge.
 *
 * Safe to call even if the user has no vendor (it just recomputes the badge).
 */
export async function onKycVerified(userId: string): Promise<void> {
  if (!userId) return;

  const vendor = await prisma.vendor.findFirst({
    where: { ownerId: userId },
    select: { id: true },
  });

  if (vendor) {
    const profile = await ensureTrustProfile(vendor.id);

    // Only promote upward — never stomp a higher level (Trusted/Business).
    if (profile.level < 1) {
      await prisma.merchantTrustProfile.update({
        where: { vendorId: vendor.id },
        data: {
          identityVerified: true,
          // REAL now: the identity lookup returns the registered phone, so the
          // owner's phone is government-matched — no separate SMS OTP needed.
          phoneVerified: true,
          level: 1,
          settlementDelayHours: settlementDelayHoursForDb(1),
          dailyWithdrawalLimit: dailyWithdrawalLimitForDb(1),
        },
      });
    }
  }

  await recomputeUserVerification(userId);
}

/**
 * Convenience: true when this user is allowed to move money OUT (convert earned
 * coins → wallet, or withdraw to bank). That gate is identity (KYC), nothing
 * more. Pass 2's convert/withdraw handlers call this.
 */
export async function isKycVerified(userId: string): Promise<boolean> {
  if (!userId) return false;
  const kyc = await prisma.kyc.findUnique({
    where: { userId },
    select: { status: true },
  });
  return kyc?.status === "verified";
}