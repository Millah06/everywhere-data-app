import { prisma } from "../../../prisma";
import { TransactionStatus } from "@prisma/client";
import { WalletService, PrismaTx } from "../../../shared/services/wallet.service";
import { TX_TYPE } from "../../../shared/utils/transactionType";
import { getVendorSettlementDelayHours } from "./settlement.rules";
import { recordRevenue } from "../../../shared/services/revenue.service";

/**
 * Phase 6 — Merchant Balance & Settlement (replaces per-order escrow).
 *
 * THE MODEL (Alipay-style, decided in BUILD_STATE Phase 6):
 *   customer pays up front (wallet debit or OPay)  ──►  merchant PENDING
 *       └─ after the trust-based settlement delay ──►  merchant AVAILABLE
 *              └─ existing wallet withdrawal rail  ──►  PAID OUT
 *
 * KEY DECISIONS encoded here:
 *  • "Available" = the owner's existing Fiat.availableBalance (Design B). On
 *    release we credit the owner's wallet so the CURRENT withdrawal flow works
 *    untouched. `MerchantBalance.available` is a reporting mirror, NOT the
 *    withdrawal source of truth (the wallet is).
 *  • Payout is NET of platform cut: net = gross − commission. The platform
 *    keeps `commission` (commission% of subtotal + any transactionFee).
 *  • Refunds make the buyer whole for the FULL gross (we return our cut too).
 *  • POD orders never reach this service — they bypass settlement entirely.
 *
 * SAFETY (mirrors the Phase 5 posture):
 *  • Fails CLOSED. If the `add_merchant_settlement` migration hasn't run on the
 *    live DB, `settlementTablesReady()` is false and the money path no-ops /
 *    throws `SettlementTablesMissingError` rather than silently losing money.
 *  • Every balance move is a single `prisma.$transaction`. Status flips use a
 *    compare-and-set (`updateMany` with a status guard) so concurrent callers
 *    (early "Release Funds" + the settlement cron) can never double-pay.
 *  • All operations are idempotent on `SettlementHold.orderId` (unique).
 */

/** Recoup outstanding POD (cash) commission from a prepaid settlement. Pass the
 *  net you're about to credit the owner; returns the adjusted net to credit. */
export async function applyPodCommissionOffset(
  db: any,                 // pass the SAME client releaseHold uses (prisma or tx)
  vendorId: string,
  net: number,
): Promise<number> {
  if (net <= 0) return net;
  const v = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { podCommissionOwed: true },
  });
  const owed = v?.podCommissionOwed ?? 0;
  if (owed <= 0) return net;
  const deduct = Math.min(owed, net);
  await db.vendor.update({
    where: { id: vendorId },
    data: { podCommissionOwed: { decrement: deduct } },
  });
  return net - deduct;
}

export class SettlementTablesMissingError extends Error {
  constructor() {
    super("Settlement tables not migrated");
    this.name = "SettlementTablesMissingError";
  }
}

export type HoldSource = "wallet" | "opay";

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Fail-closed table guard ──────────────────────────────────────────────────
// Cached after the first successful probe; on the very first miss we re-probe
// each call (cheap) so the service "wakes up" the moment the migration lands
// without needing a redeploy.
let _tablesReady: boolean | null = null;

export async function settlementTablesReady(): Promise<boolean> {
  if (_tablesReady === true) return true;
  try {
    // Touching the table is enough; count is index-only and tiny.
    await prisma.merchantBalance.count();
    _tablesReady = true;
    return true;
  } catch {
    _tablesReady = false;
    return false;
  }
}

/** Throw if the money path is invoked before the migration exists. */
async function assertTables(): Promise<void> {
  if (!(await settlementTablesReady())) throw new SettlementTablesMissingError();
}

// ── Internal helpers (run INSIDE a $transaction; take the tx client) ─────────

/** Ensure a MerchantBalance row exists for the vendor, returning it (locked by tx). */
async function ensureMerchantBalance(tx: PrismaTx, vendorId: string) {
  const existing = await tx.merchantBalance.findUnique({ where: { vendorId } });
  if (existing) return existing;
  return tx.merchantBalance.create({ data: { vendorId } });
}

/** Apply signed deltas to a merchant's reporting balances. */
async function adjustBalance(
  tx: PrismaTx,
  vendorId: string,
  delta: { pending?: number; available?: number; paidOut?: number },
) {
  await ensureMerchantBalance(tx, vendorId);
  await tx.merchantBalance.update({
    where: { vendorId },
    data: {
      ...(delta.pending ? { pending: { increment: round2(delta.pending) } } : {}),
      ...(delta.available ? { available: { increment: round2(delta.available) } } : {}),
      ...(delta.paidOut ? { paidOut: { increment: round2(delta.paidOut) } } : {}),
    },
  });
}

/** Credit an owner's WALLET (settled funds become withdrawable) within `tx`. */
async function creditOwnerWallet(
  tx: PrismaTx,
  ownerId: string,
  amount: number,
  type: string,
  metaData: Record<string, unknown>,
) {
  const { fiat } = await WalletService.ensureWalletWithFiat(tx, ownerId);
  await tx.fiat.update({
    where: { id: fiat.id },
    data: { availableBalance: { increment: round2(amount) } },
  });
  await tx.transaction.create({
    data: {
      userId: ownerId,
      type,
      amount: round2(amount),
      status: TransactionStatus.success,
      transactionRef: WalletService.generateTransactionRef(),
      metaData: metaData as any,
    },
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create the PENDING hold for a freshly-paid prepaid order, and bump the
 * merchant's pending balance by the NET payout. Called by the marketplace
 * payment handler the moment money is confirmed (wallet debit or OPay SUCCESS).
 *
 * Idempotent: a second call for the same orderId is a no-op that returns the
 * existing hold (safe for webhook + recovery retries).
 *
 * @param gross       totalAmount the buyer paid
 * @param commission  platform cut to withhold (commission + transactionFee)
 */
export async function createPendingHold(input: {
  orderId: string;
  vendorId: string;
  gross: number;
  commission: number;
  source: HoldSource;
  paymentId?: string | null;
}) {
  await assertTables();
  const { orderId, vendorId, source } = input;
  const gross = round2(input.gross);
  const commission = round2(Math.max(0, input.commission));
  const net = round2(Math.max(0, gross - commission));

  const settlementHours = await getVendorSettlementDelayHours(vendorId);
  const settleAt = new Date(Date.now() + settlementHours * 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.settlementHold.findUnique({ where: { orderId } });
    if (existing) return { created: false as const, hold: existing };

    const hold = await tx.settlementHold.create({
      data: {
        orderId,
        vendorId,
        gross,
        commission,
        net,
        status: "pending",
        settleAt,
        source,
        paymentId: input.paymentId ?? null,
      },
    });
    await adjustBalance(tx, vendorId, { pending: net });
    return { created: true as const, hold };
  });
}

/**
 * Release a pending hold: money moves Pending → Available and is credited to
 * the merchant owner's wallet (withdrawable). Used by the settlement cron when
 * the window elapses AND by the buyer's early "Release Funds" action.
 *
 * Only acts on a `pending` hold. A `frozen` (appealed) hold must be unfrozen
 * first — this is what makes "the settlement window IS the dispute window".
 * Idempotent + race-safe via the status guard.
 */
export async function releaseHold(orderId: string) {
  await assertTables();
  return prisma.$transaction(async (tx) => {
    const flip = await tx.settlementHold.updateMany({
      where: { orderId, status: "pending" },
      data: { status: "released", releasedAt: new Date() },
    });
    if (flip.count === 0) return { released: false as const, reason: "not_pending" };

    const hold = await tx.settlementHold.findUnique({ where: { orderId } });
    if (!hold) return { released: false as const, reason: "missing" };

    const vendor = await tx.vendor.findUnique({ where: { id: hold.vendorId } });
    if (!vendor) return { released: false as const, reason: "no_vendor" };

    // Pending -> Available (reporting) and credit the real wallet (withdrawable).
    await adjustBalance(tx, hold.vendorId, { pending: -hold.net, available: hold.net });

    const payout = await applyPodCommissionOffset(tx /* or your tx client */, vendor.ownerId, hold.net);
    // use `payout` (not `net`) for the MerchantBalance available/paidOut mirror too, so reporting matches.

    await creditOwnerWallet(tx, vendor.ownerId, payout, TX_TYPE.ORDER_PAYMENT, {
      orderId,
      vendorId: hold.vendorId,
      kind: "settlement",
      gross: hold.gross,
      commission: hold.commission,
      ...(hold.net > payout ? { podCommissionOffset: round2(hold.net - payout) } : {}),
      net: payout,
    });

    // ── Reconciliation: book platform revenue at SETTLEMENT (not at hold
    // creation), so a pre-settlement refund never books phantom revenue.
    // Same tx → commits atomically; idempotent by orderId; fail-open.
    await recordRevenue(tx, {
      source: "order_commission",
      track: "ngn_float",
      amount: hold.commission,
      refType: "settlement_hold",
      refId: hold.id,
      idempotencyKey: `order_commission:${orderId}`,
      note: "Marketplace commission realized on settlement",
    });
    const podRecovered = round2(hold.net - payout);
    if (podRecovered > 0) {
      await recordRevenue(tx, {
        source: "pod_commission",
        track: "ngn_float",
        amount: podRecovered,
        refType: "settlement_hold",
        refId: hold.id,
        idempotencyKey: `pod_commission:${orderId}`,
        note: "POD commission recovered via settlement offset",
      });
    }

    return { released: true as const, hold, ownerId: vendor.ownerId };
  });
}

/**
 * Freeze a pending hold because an appeal/dispute was opened — blocks the
 * payout until the dispute resolves. No balance movement (still owed, paused).
 */
export async function freezeHold(orderId: string, reason: string) {
  await assertTables();
  const flip = await prisma.settlementHold.updateMany({
    where: { orderId, status: "pending" },
    data: { status: "frozen", frozenReason: reason },
  });
  return { frozen: flip.count > 0 };
}

/**
 * Unfreeze a hold (appeal cancelled / dispute closed in vendor's favour without
 * immediate release) and restart the settlement clock from now using the
 * vendor's current trust-based delay.
 */
export async function unfreezeHold(orderId: string) {
  await assertTables();
  const hold = await prisma.settlementHold.findUnique({ where: { orderId } });
  if (!hold || hold.status !== "frozen") return { unfrozen: false as const };

  const hours = await getVendorSettlementDelayHours(hold.vendorId);
  const settleAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  const flip = await prisma.settlementHold.updateMany({
    where: { orderId, status: "frozen" },
    data: { status: "pending", frozenReason: null, settleAt },
  });
  return { unfrozen: flip.count > 0, settleAt };
}

/**
 * Refund a hold: reverse it out of the merchant's pending and make the BUYER
 * whole for the FULL gross (we return the platform cut too — buyers are never
 * shorted by a dispute). Used by appeal-in-buyer's-favour, vendor concede, and
 * auto-cancel. Credits the buyer's wallet (immediate, safe). For OPay-sourced
 * payments a provider-side refund is a later enhancement; wallet credit is the
 * correct immediate make-whole.
 *
 * Acts on `pending` OR `frozen` holds. Idempotent + race-safe.
 */
export async function refundHold(input: {
  orderId: string;
  buyerId: string;
  reason?: string;
}) {
  await assertTables();
  const { orderId, buyerId } = input;
  return prisma.$transaction(async (tx) => {
    const flip = await tx.settlementHold.updateMany({
      where: { orderId, status: { in: ["pending", "frozen"] } },
      data: { status: "refunded", refundedAt: new Date() },
    });
    if (flip.count === 0) return { refunded: false as const, reason: "not_refundable" };

    const hold = await tx.settlementHold.findUnique({ where: { orderId } });
    if (!hold) return { refunded: false as const, reason: "missing" };

    // Remove the net from the merchant's pending; pay the buyer the full gross.
    await adjustBalance(tx, hold.vendorId, { pending: -hold.net });
    await creditOwnerWallet(tx, buyerId, hold.gross, TX_TYPE.ORDER_REFUND, {
      orderId,
      vendorId: hold.vendorId,
      kind: "order_refund",
      gross: hold.gross,
      reason: input.reason ?? "refund",
    });

    return { refunded: true as const, hold };
  });
}

/**
 * Cancel a hold WITHOUT a buyer payout (the caller handles the refund itself,
 * e.g. legacy paths). Rare — most cancels should use `refundHold`.
 */
export async function cancelHold(orderId: string) {
  await assertTables();
  return prisma.$transaction(async (tx) => {
    const flip = await tx.settlementHold.updateMany({
      where: { orderId, status: { in: ["pending", "frozen"] } },
      data: { status: "cancelled" },
    });
    if (flip.count === 0) return { cancelled: false as const };
    const hold = await tx.settlementHold.findUnique({ where: { orderId } });
    if (hold) await adjustBalance(tx, hold.vendorId, { pending: -hold.net });
    return { cancelled: true as const };
  });
}

/** Dashboard read: merchant pending + lifetime settled/paid-out (reporting). */
export async function getMerchantBalanceSnapshot(vendorId: string) {
  if (!(await settlementTablesReady())) {
    return { pending: 0, settledLifetime: 0, paidOut: 0, ready: false as const };
  }
  const bal = await prisma.merchantBalance.findUnique({ where: { vendorId } });
  return {
    pending: bal?.pending ?? 0,
    settledLifetime: bal?.available ?? 0,
    paidOut: bal?.paidOut ?? 0,
    ready: true as const,
  };
}

/** Holds list for the merchant dashboard's "settlement timeline". */
export async function listVendorHolds(vendorId: string, take = 50) {
  if (!(await settlementTablesReady())) return [];
  return prisma.settlementHold.findMany({
    where: { vendorId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

// ── Settlement cron (REPLACES runAutoReleaseJob) ─────────────────────────────

/**
 * Every N minutes: release every pending hold whose settlement window has
 * elapsed (Pending → Available), then mark its order completed and refresh the
 * vendor's metrics — mirroring the old auto-release semantics, minus escrow.
 *
 * No-ops cleanly if the migration hasn't run (fail-closed).
 */
export async function runSettlementJob() {
  if (!(await settlementTablesReady())) {
    console.log("[SettlementJob] tables not migrated — skipping");
    return;
  }
  const due = await prisma.settlementHold.findMany({
    where: { status: "pending", settleAt: { lte: new Date() } },
    take: 200,
  });
  console.log(`[SettlementJob] ${due.length} hold(s) due for settlement`);

  // Lazy imports keep this file free of notification/admin deps at module load.
  const { sendNotification } = await import("../../../shared/utils/notification");

  for (const hold of due) {
    try {
      const result = await releaseHold(hold.orderId);
      if (!result.released) continue;

      // Money is settled. Now complete the order + refresh vendor metrics.
      const order = await prisma.order.update({
        where: { id: hold.orderId },
        data: { status: "completed", escrowStatus: "released" },
      });

      const all = await prisma.order.findMany({ where: { vendorId: hold.vendorId } });
      const completed = all.filter((o) => o.status === "completed");
      const rate =
        all.length > 0 ? Math.round((completed.length / all.length) * 100) : 100;
      await prisma.vendor.update({
        where: { id: hold.vendorId },
        data: { totalCompletedOrders: completed.length, completionRate: rate },
      });

      const vendor = await prisma.vendor.findUnique({
        where: { id: hold.vendorId },
        include: { user: { select: { notificationToken: true } } },
      });
      const buyer = await prisma.user.findUnique({
        where: { id: order.userId },
        select: { notificationToken: true },
      });

      if (buyer?.notificationToken) {
        await sendNotification(
          buyer.notificationToken,
          "ORDER COMPLETED",
          "Your order has been automatically completed.",
        );
      }
      if (vendor?.user.notificationToken) {
        await sendNotification(
          vendor.user.notificationToken,
          "PAYMENT SETTLED",
          `₦${hold.net.toFixed(2)} is now available in your balance.`,
        );
      }
      console.log(`[SettlementJob] settled orderId=${hold.orderId} net=${hold.net}`);
    } catch (err) {
      console.error(`[SettlementJob] failed orderId=${hold.orderId}`, err);
    }
  }
}