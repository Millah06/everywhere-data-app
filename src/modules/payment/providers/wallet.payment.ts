// src/modules/payment/providers/wallet.payment.ts
//
// Wallet provider for the payment engine. It is a THIN, idempotent wrapper over
// the existing `WalletService` (same Fiat balance model, same clientRequestId
// idempotency) so the engine moves money exactly the way the rest of the app
// already does — no new ledger semantics.
//
// "Debit before dispatch, refund on failure" (spec §12): the engine debits the
// wallet here, then `PaymentHandler.dispatch` runs. If dispatch throws, the
// controller calls `refund()` so no money is stranded.
//
// NOTE on double-charging: the EXISTING delivery checkout (`placeOrder`) locks
// wallet funds itself via WalletService.lockFundsForOrder and is UNCHANGED.
// This provider is for engine-driven flows (e.g. an OPay-or-wallet payment
// sheet) — it is a *different entry point*, so there is no double debit.

import { prisma } from "../../../prisma";
import { WalletService } from "../../../shared/services/wallet.service";
import { TX_TYPE } from "../../../shared/utils/transactionType";
import { generateUUID } from "../../../shared/utils/uuid";
import { calculateTransaction } from "../../utility/helpers/calculateTransaction";
import type { Prisma } from "@prisma/client";

export interface WalletDebitInput {
  userId: string;
  amountNaira: number;
  /** Idempotency key — reuse the Payment.clientRequestId. */
  clientRequestId: string;
  /** For the wallet history row + traceability. */
  humanRef?: string;
  metaData?: Prisma.JsonObject;
}

export interface WalletDebitResult {
  ok: boolean;
  idempotent: boolean;
  transactionId?: string;
  /** When ok=false because of funds. */
  reason?: "insufficient_balance" | "error";
}

/**
 * Atomically debit the wallet for a payment. Idempotent on clientRequestId:
 * a repeat call returns the original transaction instead of charging twice.
 *
 * Uses WalletService.chargeWalletForFee (added in Phase 4) — an atomic
 * available-balance debit that records a `success` debit transaction and is
 * itself idempotent on clientRequestId. We reuse it rather than re-implementing
 * balance math.
 */
export async function debitWallet(
  input: WalletDebitInput,
): Promise<WalletDebitResult> {
  try {
    const res = await WalletService.chargeWalletForFee({
      userId: input.userId,
      amount: input.amountNaira,
      type: TX_TYPE.ORDER_PAYMENT, // generic outbound payment type
      clientRequestId: input.clientRequestId,
      humanRef: input.humanRef,
      metaData: {
        ...(input.metaData ?? {}),
        channel: "payment_engine",
      },
    });
    return {
      ok: true,
      idempotent: res.idempotent,
      transactionId: res.transaction.id,
    };
  } catch (e: any) {
    const msg = String(e?.message || "").toLowerCase();
    if (msg.includes("insufficient")) {
      return { ok: false, idempotent: false, reason: "insufficient_balance" };
    }
    throw e;
  }
}

/**
 * Refund a previously-debited wallet payment (dispatch failed, or admin refund).
 * Credits available balance back and records a refund transaction. Idempotent
 * on `${clientRequestId}:refund` so a retried refund never double-credits.
 */
export async function refundWallet(input: {
  userId: string;
  amountNaira: number;
  clientRequestId: string;
  metaData?: Prisma.JsonObject;
}): Promise<{ ok: boolean; idempotent: boolean }> {
  const refundKey = `${input.clientRequestId}:refund`;
  return prisma.$transaction(async (tx) => {
    const dup = await tx.transaction.findUnique({
      where: { clientRequestId: refundKey },
    });
    if (dup) return { ok: true, idempotent: true };

    // Credit available balance back (Fiat is reached via the wallet).
    const { fiat } = await WalletService.ensureWalletWithFiat(tx, input.userId);
    await tx.fiat.update({
      where: { id: fiat.id },
      data: { availableBalance: { increment: input.amountNaira } },
    });

    await tx.transaction.create({
      data: {
        userId: input.userId,
        type: TX_TYPE.ORDER_REFUND,
        amount: input.amountNaira,
        status: "success",
        clientRequestId: refundKey,
        transactionRef: generateUUID(),
        metaData: {
          ...(input.metaData ?? {}),
          channel: "payment_engine",
          direction: "credit",
          reason: "payment_refund",
        },
      },
    });

    return { ok: true, idempotent: false };
  });
}

/**
 * Reward-aware wallet debit for UTILITIES (option B). Reuses the existing
 * `calculateTransaction` engine so behaviour matches the old per-service
 * controllers exactly:
 *   • `walletToDeduct` is debited from availableBalance now (no lock — engine
 *     debits up front; the utility handler refunds on delivery failure).
 *   • Reward balance is NOT changed here. The handler sets it to
 *     `finalRewardBalance` on delivery success (consumes spent reward + adds the
 *     earned bonus) or leaves it at `rewardBefore` on failure — exactly like the
 *     old `finalizeUtilityTransaction`.
 *
 * Returns a `rewardPlan` the handler/webhook use to finalise reward + refund.
 */
export interface UtilityDebitResult {
  ok: boolean;
  idempotent: boolean;
  reason?: "insufficient_balance" | "error";
  rewardPlan?: {
    walletToDeduct: number;
    rewardBefore: number;
    finalRewardBalance: number;
    rewardToAdd: number;
  };
  transactionId?: string;
}

export async function debitWalletForUtility(input: {
  userId: string;
  productAmount: number; // full price (Naira)
  useReward: boolean;
  isRecharge: boolean;
  bonusPercent: number;
  clientRequestId: string;
  humanRef?: string;
  metaData?: Prisma.JsonObject;
}): Promise<UtilityDebitResult> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.transaction.findUnique({
      where: { clientRequestId: input.clientRequestId },
    });
    if (existing) {
      const m = (existing.metaData as any) ?? {};
      return {
        ok: true,
        idempotent: true,
        transactionId: existing.id,
        rewardPlan: m.rewardPlan,
      };
    }

    const { fiat } = await WalletService.ensureWalletWithFiat(tx, input.userId);
    const rewardBefore = fiat.rewardBalance || 0;

    const calc = calculateTransaction({
      productAmount: input.productAmount,
      rewardBalance: rewardBefore,
      walletBalance: fiat.availableBalance,
      useReward: input.useReward,
      isRecharge: input.isRecharge,
      bonusPercent: input.bonusPercent,
    });

    const walletToDeduct: number = calc.walletToDeduct;
    if (fiat.availableBalance < walletToDeduct) {
      return { ok: false, idempotent: false, reason: "insufficient_balance" as const };
    }

    await tx.fiat.update({
      where: { id: fiat.id },
      data: { availableBalance: { decrement: walletToDeduct } },
    });

    const rewardPlan = {
      walletToDeduct,
      rewardBefore,
      finalRewardBalance: calc.finalRewardBalance,
      rewardToAdd: calc.rewardToAdd,
    };

    const txRow = await tx.transaction.create({
      data: {
        userId: input.userId,
        type: TX_TYPE.ORDER_PAYMENT,
        amount: walletToDeduct,
        status: "success",
        clientRequestId: input.clientRequestId,
        humanRef: input.humanRef,
        transactionRef: generateUUID(),
        metaData: { ...(input.metaData ?? {}), channel: "utility", rewardPlan },
      },
    });

    return { ok: true, idempotent: false, transactionId: txRow.id, rewardPlan };
  });
}