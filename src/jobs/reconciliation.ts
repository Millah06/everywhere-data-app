// REPO PATH: src/jobs/reconciliation.ts   (NEW FILE)
//
// Nightly reconciliation snapshot. Carries forward the most recent
// admin-entered OPay/Apple/Google balances (the cron can't know them), fetches
// Paystack live, persists a system snapshot (takenBy = null), and logs/alerts on
// a BREACH. Fail-closed: no-ops until the tables exist.

import { prisma } from "../prisma";
import { computeReconciliation } from "../shared/services/reconciliation.service";

export async function runReconciliationJob() {
  try {
    // Probe: skip cleanly before the migration lands.
    try {
      await prisma.reconciliationSnapshot.count();
    } catch {
      console.log("[ReconciliationJob] tables not migrated — skipping");
      return;
    }

    // Reuse last manual externally-known balances so the daily auto-snapshot
    // stays meaningful between manual entries.
    const last = await prisma.reconciliationSnapshot.findFirst({ orderBy: { takenAt: "desc" } });

    const r = await computeReconciliation({
      opayBalance: last?.opayBalance ?? 0,
      bankBalance: last?.bankBalance ?? 0,
      vtpassBalance: last?.vtpassBalance ?? 0,
      appleBalance: last?.appleBalance ?? 0,
      googleBalance: last?.googleBalance ?? 0,
    });

    await prisma.reconciliationSnapshot.create({
      data: {
        takenBy: null, // system
        ngnLiabilities: r.ngn.liabilities,
        ngnFloat: r.ngn.float,
        ngnSurplus: r.ngn.surplus,
        ngnStatus: r.ngn.status,
        coinLiability: r.coin.coinLiability,
        coinFunding: r.coin.funding,
        coinSurplus: r.coin.surplus,
        coinStatus: r.coin.status,
        paystackBalance: r.ngn.paystackBalance,
        opayBalance: r.ngn.opayBalance,
        bankBalance: r.ngn.bankBalance,
        vtpassBalance: r.ngn.vtpassBalance,
        appleBalance: r.coin.appleBalance,
        googleBalance: r.coin.googleBalance,
        paystackFetchOk: r.ngn.paystackFetchOk,
        figures: r as any,
        note: "auto (nightly)",
      },
    });

    if (r.ngn.status === "breach" || r.coin.status === "breach") {
      console.error(
        `[ReconciliationJob] ⚠ BREACH — NGN surplus ₦${r.ngn.surplus} (liab ₦${r.ngn.liabilities}), ` +
          `coin surplus ₦${r.coin.surplus} (liab ₦${r.coin.coinLiability})`,
      );
      // Optional: wire sendNotification to admin tokens here.
    } else {
      console.log(
        `[ReconciliationJob] ok — NGN surplus ₦${r.ngn.surplus}, coin surplus ₦${r.coin.surplus}`,
      );
    }
  } catch (e: any) {
    console.error("[ReconciliationJob] failed (non-fatal):", e?.message ?? e);
  }
}