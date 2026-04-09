import { prisma } from "../../../prisma";
import admin from "firebase-admin";
import { sendNotification } from "../../../shared/utils/notification";
import { WalletService } from "../../../shared/services/wallet.service";
import { TX_TYPE } from "../../../shared/utils/transactionType";

const notify = async (token: string, title: string, body: string) => {
  await sendNotification(token, title, body);
};

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

      await notify(
        escrow.order.userId,
        "ORDER AUTOMATICALLY COMPLETED",
        "Your order has been automatically completed.",
      );

      if (vendor) {
        await notify(
          vendor.user.notificationToken!,
          "ORDER AUTOMATICALLY COMPLETED",
          "A payment has been released to your account.",
        );
      }

      console.log(`[EscrowJob] Released orderId=${escrow.orderId}`);
    } catch (err) {
      console.error(`[EscrowJob] Failed orderId=${escrow.orderId}`, err);
    }
  }
};

export const runAutoCancelJob = async () => {
  // Find orders still "pending" after 30 minutes with no vendor action
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);

  const stale = await prisma.order.findMany({
    where: { status: "pending", createdAt: { lt: cutoff } },
    include: { escrow: true },
  });

  for (const order of stale) {
    const updated = await prisma.order.updateMany({
      where: { id: order.id },
      data: { status: "cancelled", escrowStatus: "released" },
    });

    if (updated.count === 0) continue;

    if (order.escrow) {
      await prisma.escrow.update({
        where: { orderId: order.id },
        data: { releaseStatus: "refunded" },
      });
    }

    const vendor = await prisma.vendor.findUnique({
      where: { id: order.vendorId },
      include: { user: { select: { notificationToken: true } } },
    });

    const user = await prisma.user.findUnique({
      where: { id: order.userId },
      select: { notificationToken: true },
    });

    if (!vendor) continue;
    if (!user) continue;

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

    await notify(
      user?.notificationToken!,
      "ORDER AUTOMATICALLY CANCELLED",
      "Your order has been automatically cancelled due to no response from the vendor.",
    );

    await notify(
      vendor.user.notificationToken!,
      "ORDER AUTOMATICALLY CANCELLED",
      "An order has been automatically cancelled due to no response from you.",
    );
  }
};
