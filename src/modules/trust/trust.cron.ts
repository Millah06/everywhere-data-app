// src/modules/trust/trust.cron.ts
//
// PHASE 4 — Merchant Trust System (nightly job)
// ─────────────────────────────────────────────────────────────────────────────
// Auto-manages the AUTOMATIC tier (level 1 ⇄ level 2) only:
//   • Promote 1 → 2 when the vendor meets the Trusted thresholds
//     (50+ completed orders, <5% disputes, 60+ days). Spec §11 / §20.
//   • Defensively demote 2 → 1 if a vendor's dispute rate later breaches the
//     threshold (keeps settlement promises honest). Account age never regresses,
//     so age is not re-checked on demotion.
//
// It deliberately NEVER touches level 0 (needs manual KYC) or level 3 (admin-
// gated). Whenever it changes a level it re-syncs settlementDelayHours /
// dailyWithdrawalLimit via the shared settlement rules, so the escrow timer and
// withdrawal limits stay correct without any other code knowing the rules.
//
// Migration-safe: if the trust table isn't present yet (gated phase1 migration),
// the job logs and no-ops instead of throwing.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../../prisma";
import {
  settlementDelayHoursForDb,
  dailyWithdrawalLimitForDb,
} from "../marketPlace/settlement/settlement.rules";
import {
  computeVendorTrustStats,
  meetsLevel2,
  L2_MAX_DISPUTE_RATE,
} from "./trust.controller";

export const runTrustUpgradeJob = async () => {
  const startedAt = new Date().toISOString();
  console.log(`[TrustJob] Running at ${startedAt}`);

  let profiles: { vendorId: string; level: number }[] = [];
  try {
    profiles = await prisma.merchantTrustProfile.findMany({
      where: { level: { in: [1, 2] } },
      select: { vendorId: true, level: true },
    });
  } catch (err) {
    // Table not migrated yet — safe no-op.
    console.warn("[TrustJob] Trust table unavailable; skipping.", err);
    return;
  }

  let promoted = 0;
  let demoted = 0;

  for (const p of profiles) {
    try {
      const stats = await computeVendorTrustStats(p.vendorId);

      // Promote 1 → 2
      if (p.level === 1 && meetsLevel2(stats)) {
        await prisma.merchantTrustProfile.update({
          where: { vendorId: p.vendorId },
          data: {
            level: 2,
            settlementDelayHours: settlementDelayHoursForDb(2),
            dailyWithdrawalLimit: dailyWithdrawalLimitForDb(2),
          },
        });
        promoted++;
        await notifyVendor(
          p.vendorId,
          "YOU'RE NOW A TRUSTED MERCHANT",
          "Faster 24h settlements and a higher withdrawal limit are now active.",
        );
        continue;
      }

      // Defensive demote 2 → 1 (dispute rate breached the level-2 ceiling).
      if (p.level === 2 && stats.disputeRatePercent >= L2_MAX_DISPUTE_RATE) {
        await prisma.merchantTrustProfile.update({
          where: { vendorId: p.vendorId },
          data: {
            level: 1,
            settlementDelayHours: settlementDelayHoursForDb(1),
            dailyWithdrawalLimit: dailyWithdrawalLimitForDb(1),
          },
        });
        demoted++;
        await notifyVendor(
          p.vendorId,
          "TRUST LEVEL UPDATED",
          "Your trust level changed due to a rise in disputes. Resolve open issues to regain Trusted status.",
        );
      }
    } catch (err) {
      console.error(`[TrustJob] Failed vendorId=${p.vendorId}`, err);
    }
  }

  console.log(
    `[TrustJob] Done. promoted=${promoted} demoted=${demoted} scanned=${profiles.length}`,
  );
};

async function notifyVendor(vendorId: string, title: string, body: string) {
  try {
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      include: { user: { select: { notificationToken: true } } },
    });
    const token = vendor?.user?.notificationToken;
    if (!token) return;
    const { sendNotification } = await import("../../shared/utils/notification");
    await sendNotification(token, title, body);
  } catch {
    // notifications are best-effort
  }
}