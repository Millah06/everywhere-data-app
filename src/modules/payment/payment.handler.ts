// src/modules/payment/payment.handler.ts
//
// The dispatcher that turns a SUCCESSFUL payment into a completed business
// action. This is the "do not couple payment logic to marketplace orders"
// requirement made concrete: the engine knows nothing about orders — it just
// looks up a handler by `entityType` and calls it.
//
// Adding a new payable thing later = register a new handler from that module:
//
//     import { registerPaymentHandler } from "../payment/payment.handler";
//     registerPaymentHandler("dine_in_order", async (payment) => { ... });
//
// No edit to the engine is needed. That keeps Phase 7 (dine-in) and any future
// service decoupled from this file.

import { prisma } from "../../prisma";
import { PAYMENT_ENTITY, PAYMENT_PROVIDER } from "./payment.types";
import { createPendingHold } from "../marketPlace/settlement/settlement.service";
import { pingOrderParties } from "../marketPlace/order/orderPing";

// A handler receives the SUCCESS payment and completes its side effect.
// It MUST be idempotent: the recovery cron + webhook can both fire for the same
// payment, so a handler may be invoked more than once for one payment.
export type PaymentHandlerFn = (payment: any) => Promise<void>;

const registry = new Map<string, PaymentHandlerFn>();

export function registerPaymentHandler(entityType: string, fn: PaymentHandlerFn) {
  registry.set(entityType, fn);
}

export function hasPaymentHandler(entityType: string): boolean {
  return registry.has(entityType);
}

/**
 * Dispatch a SUCCESS payment to its business handler. Called once the status is
 * authoritatively SUCCESS (after OPay re-query, or right after a wallet debit).
 *
 * If no handler is registered for the entityType we DO NOT silently swallow it:
 * we throw, and the caller records the error on the Payment (so it surfaces for
 * manual review) while leaving the money state intact. This is the honest
 * behaviour for an entityType whose handler ships in a later phase.
 */
export async function dispatch(payment: any): Promise<void> {
  const handler = registry.get(payment.entityType);
  if (!handler) {
    throw new Error(
      `No payment handler registered for entityType="${payment.entityType}" ` +
        `(paymentId=${payment.id}). Register one from its module.`,
    );
  }
  await handler(payment);
}

// ─────────────────────────────────────────────────────────────────────────────
// marketplace_order — Phase 6 (settlement model). Serves BOTH wallet- and
// OPay-paid orders now: `placeOrder` creates the order UNPAID and the universal
// PaymentSheet pays it through the engine, which lands here on SUCCESS.
//
// The link is Payment.entityId → Order.id. On SUCCESS we credit the merchant's
// PENDING balance with the NET payout, then confirm the order. NO escrow row.
//
// ORDER OF OPERATIONS matters: create the hold FIRST, confirm SECOND. If the
// hold write fails (e.g. before the settlement migration runs, it fails closed),
// the order stays `pending` and the whole dispatch throws — so the wallet path
// refunds cleanly and the order auto-cancels, instead of leaving a confirmed
// order with no money parked.
//
// Fully idempotent: the status guard returns early once confirmed, and
// createPendingHold is a no-op if the hold already exists (webhook + recovery
// cron can both fire for one payment).
// ─────────────────────────────────────────────────────────────────────────────
registerPaymentHandler(PAYMENT_ENTITY.MARKETPLACE_ORDER, async (payment) => {
  const orderId: string = payment.entityId;
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    throw new Error(
      `marketplace_order handler: order ${orderId} not found for payment ${payment.id}`,
    );
  }

  // Idempotency: already past pending → nothing to do.
  if (order.status !== "pending") return;

  //   commission = subtotal·commission% + transactionFee   (platform revenue)
  //   net        = totalAmount − commission                (computed in createPendingHold)
  const cfg = await prisma.appConfig.findFirst();
  const commissionPct = cfg?.commissionPercent ?? 5;
  const commission =
    order.subtotal * (commissionPct / 100) + order.transactionFee;

  // 1) Park the merchant's NET in PENDING (idempotent on orderId).
  await createPendingHold({
    orderId: order.id,
    vendorId: order.vendorId,
    gross: order.totalAmount,
    commission,
    source: payment.provider === PAYMENT_PROVIDER.OPAY ? "opay" : "wallet",
    paymentId: payment.id,
  });

  // 2) Confirm the order and record HOW it was actually paid (wallet|opay),
  //    replacing the placeholder "prepaid" set at checkout.
  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: "confirmed",
      escrowStatus: "held",
      paymentMethod:
        payment.provider === PAYMENT_PROVIDER.OPAY ? "opay" : "wallet",
    },
  });

  // 3) Realtime: now that it's paid + confirmed, ping so the vendor's list
  //    refreshes and the new order appears without a manual refresh.
  await pingOrderParties(order.id);
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAMS for later phases — intentionally NOT registered here.
//
//   • "dine_in_order" → registered by the dine-in module in Phase 7 (it will
//                       mirror this handler: confirm + createPendingHold).
//   • "utility"       → the existing VTPass utility flow does not route through
//                       the engine yet; when it migrates, that module registers
//                       its own handler.
//
// Until then, a payment created with one of those entityTypes will SUCCEED at
// the money layer and then `dispatch()` will throw "no handler registered",
// which the controller records as `providerMeta.dispatchError` for manual
// review. We deliberately do not register empty no-op handlers, because a
// silent no-op would take a customer's money and do nothing.
// ─────────────────────────────────────────────────────────────────────────────

export const PaymentHandler = { dispatch, registerPaymentHandler, hasPaymentHandler };
export default PaymentHandler;