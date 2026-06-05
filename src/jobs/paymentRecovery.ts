// src/jobs/paymentRecovery.ts
//
// Payment recovery (spec §13). Runs every 5 minutes (registered in jobs/index.ts):
//   1. Re-query OPay for PENDING/VERIFYING payments older than ~2 min and
//      resolve them to SUCCESS/FAILED (covers "user closed app / lost network /
//      phone died" — the backend finishes the job regardless of the client).
//   2. Expire CREATED payments older than 30 min (no money moved).
//   3. Retry dispatch for SUCCESS payments that have a lingering dispatchError.
//
// Migration-safe: if the Payment table doesn't exist yet (gated phase1
// migration), every query throws P2021 and we no-op quietly — exactly like the
// trust cron.

import { prisma } from "../prisma";
import {
  PAYMENT_STATUS,
  PAYMENT_PROVIDER,
  PAYMENT_EXPIRY_MINUTES,
} from "../modules/payment/payment.types";
import { reconcileOpayPayment } from "../modules/payment/payment.controller";
import { dispatch } from "../modules/payment/payment.handler";

const STUCK_AFTER_MS = 2 * 60 * 1000; // only touch payments older than 2 min

function isMissingTable(e: any): boolean {
  return e?.code === "P2021" || e?.code === "P2022";
}

export const runPaymentRecoveryJob = async () => {
  try {
    const now = Date.now();
    const stuckCutoff = new Date(now - STUCK_AFTER_MS);

    // 1) Resolve in-flight OPay payments.
    const inFlight = await prisma.payment.findMany({
      where: {
        provider: PAYMENT_PROVIDER.OPAY,
        status: { in: [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.VERIFYING] },
        updatedAt: { lt: stuckCutoff },
      },
      take: 50,
    });
    for (const p of inFlight) {
      try {
        await reconcileOpayPayment(p);
      } catch (e: any) {
        console.error(`[paymentRecovery] reconcile ${p.id} failed`, e?.message || e);
      }
    }

    // 2) Expire stale CREATED sessions.
    const expiryCutoff = new Date(now - PAYMENT_EXPIRY_MINUTES * 60 * 1000);
    await prisma.payment.updateMany({
      where: { status: PAYMENT_STATUS.CREATED, createdAt: { lt: expiryCutoff } },
      data: { status: PAYMENT_STATUS.EXPIRED },
    });

    // 3) Retry dispatch for SUCCESS payments whose handler errored earlier.
    const needsDispatch = await prisma.payment.findMany({
      where: {
        status: PAYMENT_STATUS.SUCCESS,
        NOT: { providerMeta: { equals: null } },
      },
      take: 50,
    });
    for (const p of needsDispatch) {
      if (!(p.providerMeta as any)?.dispatchError) continue;
      try {
        await dispatch(p);
        await prisma.payment.update({
          where: { id: p.id },
          data: { providerMeta: { ...(p.providerMeta as any), dispatchError: null } },
        });
      } catch (e: any) {
        // still failing — leave the error in place for the next run / manual review
      }
    }

    if (inFlight.length) {
      console.log(`[paymentRecovery] reconciled ${inFlight.length} in-flight OPay payment(s)`);
    }
  } catch (e: any) {
    if (isMissingTable(e)) return; // engine not migrated yet — no-op
    console.error("[paymentRecovery] job error", e?.message || e);
  }
};