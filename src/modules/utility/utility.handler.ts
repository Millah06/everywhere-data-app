// src/modules/utility/utility.handler.ts
//
// Registers the engine's `utility` payment handler. Import this once at startup
// (add `import "../modules/utility/utility.handler";` to src/routes/index.ts) so
// the side-effect registration runs.
//
// Flow: PaymentSheet creates Payment(entityType="utility", meta=<UtilityRequest>)
// → engine takes the money:
//     • wallet → reward-aware debit (calculateTransaction) stores a `rewardPlan`
//       on the Payment (option B: reward spend + bonus earn preserved),
//     • OPay   → full amount via OPay.
// → on SUCCESS this handler fulfils with VTPass:
//     • delivered → finalise reward (wallet: set to rewardPlan.finalRewardBalance;
//                   OPay: credit earned bonus), store token(s) for the receipt.
//     • pending   → store vtpassRequestId(=payment.id); the VTPass webhook finalises.
//     • failed    → refund (wallet: rewardPlan.walletToDeduct; OPay: full amount)
//                   to the user's wallet, reward left untouched (never changed on debit).
//
// Idempotent: re-running after delivered/refunded is a no-op.

import { prisma } from "../../prisma";
import { registerPaymentHandler } from "../payment/payment.handler";
import { WalletService } from "../../shared/services/wallet.service";
import { TX_TYPE } from "../../shared/utils/transactionType";
import { generateUUID } from "../../shared/utils/uuid";
import { deliverUtility, type UtilityRequest } from "./utility.deliver";

async function bonusPercentFor(service: string): Promise<number> {
  const cfg = await WalletService.getBonusConfig();
  switch (service) {
    case "airtime": return cfg.airtime ?? 0;
    case "data": return cfg.data ?? 0;
    case "cable": return cfg.cable ?? 0;
    case "electricity": return cfg.electric ?? 0;
    default: return 0;
  }
}

async function setDelivery(paymentId: string, delivery: Record<string, unknown>, providerMeta: any) {
  await prisma.payment.update({
    where: { id: paymentId },
    data: { providerMeta: { ...(providerMeta ?? {}), delivery } },
  });
}

/** Finalise reward on delivery success. */
async function finaliseRewardOnSuccess(payment: any, service: string) {
  const plan = (payment.providerMeta as any)?.rewardPlan;
  await prisma.$transaction(async (tx) => {
    const { fiat } = await WalletService.ensureWalletWithFiat(tx, payment.userId);
    if (plan && typeof plan.finalRewardBalance === "number") {
      // Wallet path: SET to the precomputed balance (consumes spent + adds earned).
      await tx.fiat.update({ where: { id: fiat.id }, data: { rewardBalance: plan.finalRewardBalance } });
    } else {
      // OPay path (no reward plan): EARN bonus only.
      const pct = await bonusPercentFor(service);
      const bonus = pct > 0 && payment.amount ? (payment.amount * pct) / 100 : 0;
      if (bonus > 0) {
        await tx.fiat.update({ where: { id: fiat.id }, data: { rewardBalance: { increment: bonus } } });
      }
    }
  });
}

/** Refund to wallet on delivery failure (works for wallet- and OPay-paid). */
async function refundUtility(payment: any, reason: string) {
  const plan = (payment.providerMeta as any)?.rewardPlan;
  const amount = plan?.walletToDeduct ?? payment.amount; // actual amount taken
  const refundKey = `${payment.clientRequestId}:utility-refund`;
  await prisma.$transaction(async (tx) => {
    const dup = await tx.transaction.findUnique({ where: { clientRequestId: refundKey } });
    if (dup) return; // already refunded
    const { fiat } = await WalletService.ensureWalletWithFiat(tx, payment.userId);
    await tx.fiat.update({ where: { id: fiat.id }, data: { availableBalance: { increment: amount } } });
    await tx.transaction.create({
      data: {
        userId: payment.userId,
        type: TX_TYPE.ORDER_REFUND,
        amount,
        status: "success",
        clientRequestId: refundKey,
        transactionRef: generateUUID(),
        metaData: { paymentId: payment.id, channel: "utility", reason, direction: "credit" },
      },
    });
  });
}

/**
 * Shared finaliser used by the handler (sync) AND the VTPass webhook (async
 * pending → resolved). Safe to call more than once.
 */
export async function finaliseUtilityDelivery(
  payment: any,
  delivered: boolean,
  vendorResponse?: unknown,
  tokenInfo?: { token?: string | null; tokens?: unknown; productName?: string | null },
) {
  const req = ((payment.providerMeta as any)?.meta ?? {}) as UtilityRequest;
  const already = (payment.providerMeta as any)?.delivery?.status;
  if (already === "delivered" || already === "refunded") return;

  if (delivered) {
    await finaliseRewardOnSuccess(payment, req.service);
    await setDelivery(
      payment.id,
      {
        status: "delivered",
        token: tokenInfo?.token ?? null,
        tokens: tokenInfo?.tokens ?? null,
        productName: tokenInfo?.productName ?? req.productName ?? null,
        bonusEarned: (payment.providerMeta as any)?.rewardPlan?.rewardToAdd ?? null,
      },
      payment.providerMeta,
    );
  } else {
    await refundUtility(payment, "vtpass_failed");
    await setDelivery(
      payment.id,
      { status: "refunded", reason: "vtpass_failed", vendorResponse: vendorResponse ?? null },
      payment.providerMeta,
    );
  }
}

registerPaymentHandler("utility", async (payment) => {
  const status = (payment.providerMeta as any)?.delivery?.status;
  if (status === "delivered" || status === "refunded") return; // idempotent

  const req = ((payment.providerMeta as any)?.meta ?? {}) as UtilityRequest;
  if (!req?.service || !req?.serviceID) {
    await refundUtility(payment, "missing_utility_params");
    await setDelivery(payment.id, { status: "refunded", reason: "missing_params" }, payment.providerMeta);
    return;
  }

  const result = await deliverUtility(req, payment.id);

  if (result.status === "pending") {
    await setDelivery(payment.id, { status: "pending", vtpassRequestId: payment.id }, payment.providerMeta);
    return;
  }

  await finaliseUtilityDelivery(payment, result.status === "delivered", result.vendorResponse, {
    token: result.token,
    tokens: result.tokens,
    productName: result.productName,
  });
});