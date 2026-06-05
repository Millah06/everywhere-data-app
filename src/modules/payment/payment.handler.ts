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
// No edit to the engine is needed. That keeps Phase 6 (dine-in) and any future
// service decoupled from this file.

import { prisma } from "../../prisma";
import { PAYMENT_ENTITY } from "./payment.types";
import { getVendorSettlementDelayHours } from "../marketPlace/settlement/settlement.rules";

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
// marketplace_order — REAL handler, wired in Phase 5.
//
// The link is Payment.entityId → Order.id. On SUCCESS we confirm the order and
// ensure its escrow exists, using ONLY existing Order/Escrow columns (no schema
// change, no new migration). Fully idempotent: re-running is a no-op once the
// order is already confirmed / escrow already exists.
//
// This handler is what an OPay-paid order uses. The existing wallet checkout
// (`placeOrder`) is untouched and does NOT go through here.
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

  // Settlement delay is trust-based (fail-open to AppConfig.autoReleaseHours).
  const settlementHours = await getVendorSettlementDelayHours(order.vendorId);

  await prisma.$transaction(async (tx) => {
    // Confirm the order (vendor will see it as a new incoming order).
    await tx.order.update({
      where: { id: order.id },
      data: { status: "confirmed", escrowStatus: "held" },
    });

    // Ensure escrow exists (created once, idempotently).
    const existing = await tx.escrow.findUnique({ where: { orderId: order.id } });
    if (!existing) {
      await tx.escrow.create({
        data: {
          orderId: order.id,
          amountHeld: order.totalAmount,
          commission: 0, // commission already reflected in transactionFee at placement
          releaseStatus: "held",
          autoReleaseAt: new Date(Date.now() + settlementHours * 60 * 60 * 1000),
        },
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAMS for later phases — intentionally NOT registered here.
//
//   • "dine_in_order" → registered by the dine-in module in Phase 6.
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