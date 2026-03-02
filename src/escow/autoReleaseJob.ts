 
import { prisma } from "../prisma";
import admin from "firebase-admin";

const notify = async (
  userId: string,
  type: string,
  data: Record<string, any>,
) => {
  await admin.firestore().collection("notifications").add({
    recipientId: userId,
    type,
    data,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
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

      await prisma.order.update({
        where: { id: escrow.orderId },
        data: { status: "completed", escrowStatus: "released" },
      });

      const all = await prisma.order.findMany({
        where: { vendorId: escrow.order.vendorId },
      });
      const completed = all.filter((o) => o.status === "completed");
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
      });

      await notify(escrow.order.userId, "ESCROW_AUTO_RELEASED", {
        orderId: escrow.orderId,
      });

      if (vendor) {
        await notify(vendor.ownerId, "PAYMENT_RELEASED", {
          orderId: escrow.orderId,
          amount: escrow.amountHeld - escrow.commission,
        });
      }

      console.log(`[EscrowJob] Released orderId=${escrow.orderId}`);
    } catch (err) {
      console.error(`[EscrowJob] Failed orderId=${escrow.orderId}`, err);
    }
  }
};
