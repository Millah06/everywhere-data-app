import { prisma } from "../../../prisma";
import admin from "firebase-admin";
import { sendNotification } from "../../../shared/utils/notification";
import { WalletService } from "../../../shared/services/wallet.service";
import { TX_TYPE } from "../../../shared/utils/transactionType";
import { pingOrderParties } from "../order/orderPing";
import { refundHold, settlementTablesReady } from "../settlement/settlement.service";

const notify = async (token: string, title: string, body: string) => {
  await sendNotification(token, title, body);
};

/**
 * LEGACY escrow auto-release. Phase 6 settlement holds are released by
 * `runSettlementJob`; this only drains old `Escrow` rows still in flight.
 */
export const runAutoReleaseJob = async () => {
  console.log(`[EscrowJob] Running at ${new Date().toISOString()}`);

  const expired = await prisma.escrow.findMany({
    where: { releaseStatus: "held", autoReleaseAt: { lte: new Date() } },
    include: { order: true },
  });

  console.log(`[EscrowJob] ${expired.length} escrow(s) to auto-release`);

  for (const escrow of expired) {
    try {
      await prisma.escrow.update({
        where: { id: escrow.id },
        data: { releaseStatus: "released", releasedAt: new Date() },
      });

      const order = await prisma.order.update({
        where: { id: escrow.orderId },
        data: { status: "completed", escrowStatus: "released" },
      });

      const all = await prisma.order.findMany({
        where: { vendorId: escrow.order.vendorId },
      });
      const completed = all.filter((o: any) => o.status === "completed");
      const rate =
        all.length > 0
          ? Math.round((completed.length / all.length) * 100)
          : 100;

      await prisma.vendor.update({
        where: { id: escrow.order.vendorId },
        data: { totalCompletedOrders: completed.length, completionRate: rate },
      });

      const vendor = await prisma.vendor.findUnique({
        where: { id: escrow.order.vendorId },
        include: { user: { select: { notificationToken: true } } },
      });

      await WalletService.creditAvailableBalance({
        userId: vendor!.ownerId,
        amount: order.totalAmount,
      });
      await WalletService.createCreditTransaction({
        userId: vendor!.ownerId,
        amount: order.totalAmount,
        type: TX_TYPE.ORDER_PAYMENT,
        metaData: { orderId: order.id, vendorId: vendor!.id },
      });

      await WalletService.releaseEscow({
        userId: order.userId,
        amount: order.totalAmount,
        orderId: order.id,
      });

      // Notify the buyer (fetch the real token — userId is NOT a token).
      const buyer = await prisma.user.findUnique({
        where: { id: order.userId },
        select: { notificationToken: true },
      });
      if (buyer?.notificationToken) {
        await notify(
          buyer.notificationToken,
          "ORDER AUTOMATICALLY COMPLETED",
          "Your order has been automatically completed.",
        );
      }
      if (vendor?.user?.notificationToken) {
        await notify(
          vendor.user.notificationToken,
          "ORDER AUTOMATICALLY COMPLETED",
          "A payment has been released to your account.",
        );
      }

      await pingOrderParties(order.id);

      console.log(`[EscrowJob] Released orderId=${escrow.orderId}`);
    } catch (err) {
      console.error(`[EscrowJob] Failed orderId=${escrow.orderId}`, err);
    }
  }
};

/**
 * Auto-cancel orders left "pending" for 30 min (no payment / no vendor action).
 *
 * MONEY-SAFE refund routing — only move funds that actually exist:
 *   • settlement hold  → reverse the hold (defensive; a paid order is already
 *                        "confirmed", so this is effectively unreachable)
 *   • legacy escrow    → unchanged locked-funds refund
 *   • neither          → UNPAID prepaid or POD: cancel only, NO money moved
 *
 * (The old version unconditionally refunded locked funds, crediting money that
 * was never taken for unpaid/POD orders.)
 */
export const runAutoCancelJob = async () => {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);

  const stale = await prisma.order.findMany({
    where: { status: "pending", createdAt: { lt: cutoff } },
    include: { escrow: true },
  });

  for (const order of stale) {
    // Race-guarded flip so a concurrent payment/accept can't be clobbered.
    const updated = await prisma.order.updateMany({
      where: { id: order.id, status: "pending" },
      data: { status: "cancelled", escrowStatus: "cancelled" },
    });
    if (updated.count === 0) continue;

    try {
      const hasHold =
        (await settlementTablesReady()) &&
        !!(await prisma.settlementHold.findUnique({
          where: { orderId: order.id },
        }));

      if (hasHold) {
        await refundHold({
          orderId: order.id,
          buyerId: order.userId,
          reason: "auto_cancel",
        });
      } else if (order.escrow) {
        await prisma.escrow.update({
          where: { orderId: order.id },
          data: { releaseStatus: "refunded" },
        });
        await WalletService.moveLockedToAvailableCredit({
          userId: order.userId,
          amount: order.totalAmount,
        });
        await WalletService.createCreditTransaction({
          userId: order.userId,
          amount: order.totalAmount,
          type: TX_TYPE.ORDER_REFUND,
          metaData: { orderId: order.id, vendorId: order.vendorId },
        });
      }
      // else: UNPAID prepaid / POD — nothing was taken, nothing to refund.
    } catch (err) {
      console.error(`[AutoCancel] refund failed orderId=${order.id}`, err);
    }

    const vendor = await prisma.vendor.findUnique({
      where: { id: order.vendorId },
      include: { user: { select: { notificationToken: true } } },
    });
    const user = await prisma.user.findUnique({
      where: { id: order.userId },
      select: { notificationToken: true },
    });

    if (user?.notificationToken) {
      await notify(
        user.notificationToken,
        "ORDER AUTOMATICALLY CANCELLED",
        "Your order was automatically cancelled (no payment or no vendor response in time).",
      );
    }
    if (vendor?.user?.notificationToken) {
      await notify(
        vendor.user.notificationToken,
        "ORDER AUTOMATICALLY CANCELLED",
        "An order was automatically cancelled (no payment or no response in time).",
      );
    }

    // Realtime: reflect the cancellation live for both sides.
    await pingOrderParties(order.id);
  }
};