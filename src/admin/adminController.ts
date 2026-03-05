import { prisma } from "../prisma";
import { checkAuth } from "../webhook/utils/auth";
import admin from "../webhook/utils/firebase";

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

const getPendingVendors = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const vendors = await prisma.vendor.findMany({
      where: { status: "pending" },
      include: { branches: true },
      orderBy: { createdAt: "asc" },
    });

    res.json(vendors);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const approveVendor = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const { vendorId } = req.params;

    const vendor = await prisma.vendor.update({
      where: { id: vendorId },
      data: { status: "approved", isVisible: true },
    });

    await notify(vendor.ownerId, "VENDOR_APPROVED", {
      vendorName: vendor.name,
    });

    res.json(vendor);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const rejectVendor = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const { vendorId } = req.params;
    const { reason } = req.body;

    const vendor = await prisma.vendor.update({
      where: { id: vendorId },
      data: { status: "rejected" },
    });

    await notify(vendor.ownerId, "VENDOR_REJECTED", {
      vendorName: vendor.name,
      reason: reason || "Application did not meet our requirements",
    });

    res.json(vendor);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getAppeals = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const orders = await prisma.order.findMany({
      where: { status: "appealed" },
      include: { items: true, escrow: true },
      orderBy: { updatedAt: "asc" },
    });

    res.json(orders);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const resolveAppeal = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const { orderId } = req.params;
    const { decision, reason } = req.body;

    if (!["release_vendor", "refund_user"].includes(decision)) {
      return res
        .status(400)
        .json({ message: "decision must be release_vendor or refund_user" });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { escrow: true },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.status !== "appealed")
      return res.status(400).json({ message: "Order is not under appeal" });

    const vendor = await prisma.vendor.findUnique({
      where: { id: order.vendorId },
    });

    if (decision === "release_vendor") {
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "completed", escrowStatus: "released" },
      });
      await prisma.escrow.update({
        where: { orderId },
        data: { releaseStatus: "released", releasedAt: new Date() },
      });

      if (vendor) {
        const all = await prisma.order.findMany({
          where: { vendorId: vendor.id },
        });
        const completed = all.filter((o: any) => o.status === "completed");
        const rate =
          all.length > 0
            ? Math.round((completed.length / all.length) * 100)
            : 100;
        await prisma.vendor.update({
          where: { id: vendor.id },
          data: {
            totalCompletedOrders: completed.length,
            completionRate: rate,
          },
        });
        await notify(vendor.ownerId, "APPEAL_RESOLVED_IN_YOUR_FAVOUR", {
          orderId,
          reason,
        });
      }

      await notify(order.userId, "APPEAL_RESOLVED", {
        orderId,
        decision: "in_favour_of_vendor",
        reason,
      });
    } else {
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "cancelled", escrowStatus: "refunded" },
      });
      await prisma.escrow.update({
        where: { orderId },
        data: { releaseStatus: "refunded", releasedAt: new Date() },
      });

      await notify(order.userId, "APPEAL_RESOLVED", {
        orderId,
        decision: "in_favour_of_user",
        reason,
      });

      if (vendor) {
        await notify(vendor.ownerId, "APPEAL_RESOLVED_REFUND_ISSUED", {
          orderId,
          reason,
        });
      }
    }

    res.json({ success: true, decision, orderId });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getConfig = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const config = await prisma.appConfig.findFirst();
    res.json(config);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const updateConfig = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const {
      transactionFeePercent,
      autoReleaseHours,
      appealWindowHours,
      chatCloseHours,
      commissionPercent,
    } = req.body;

    const config = await prisma.appConfig.upsert({
      where: { id: "singleton" },
      update: {
        ...(transactionFeePercent !== undefined && { transactionFeePercent }),
        ...(autoReleaseHours !== undefined && { autoReleaseHours }),
        ...(appealWindowHours !== undefined && { appealWindowHours }),
        ...(chatCloseHours !== undefined && { chatCloseHours }),
        ...(commissionPercent !== undefined && { commissionPercent }),
      },
      create: {
        id: "singleton",
        transactionFeePercent: transactionFeePercent ?? 0,
        autoReleaseHours: autoReleaseHours ?? 24,
        appealWindowHours: appealWindowHours ?? 48,
        chatCloseHours: chatCloseHours ?? 72,
        commissionPercent: commissionPercent ?? 5,
      },
    });

    res.json(config);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
  getPendingVendors,
  approveVendor,
  rejectVendor,
  getAppeals,
  resolveAppeal,
  getConfig,
  updateConfig,
};
