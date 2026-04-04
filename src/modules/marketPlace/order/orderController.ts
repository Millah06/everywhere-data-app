import { prisma } from "../../../prisma";
import admin from "firebase-admin";
import { sendNotification } from "../../../shared/utils/notification";
import { generateUUID } from "../../../shared/utils/uuid";
import { Order } from "@prisma/client";
import { WalletService } from "../../../shared/services/wallet.service";
import {
  prismaTransactionStatusToApi,
  withTransactionStatus,
} from "../../../shared/utils/transactionResponse";
import { FieldValue } from "firebase-admin/firestore";

const notify = async (token: string, title: string, body: string) => {
  await sendNotification(token, title, body);
};

const recalculateVendorMetrics = async (vendorId: string) => {
  const all = await prisma.order.findMany({ where: { vendorId } });
  const completed = all.filter((o: any) => o.status === "completed");
  const rate =
    all.length > 0 ? Math.round((completed.length / all.length) * 100) : 100;
  await prisma.vendor.update({
    where: { id: vendorId },
    data: { totalCompletedOrders: completed.length, completionRate: rate },
  });
};

const placeOrder = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const user = await prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        notificationToken: true,
        name: true,
      },
    });

    const clientRequestId = "";

    const notificationToken = user?.notificationToken;

    const { vendorId, branchId, items, deliveryAddress, paymentMethod } =
      req.body;

    const config = await prisma.appConfig.findFirst();
    if (!config)
      return res
        .status(500)
        .json({ message: "App config not found. Ask admin to seed it." });

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { vendor: true, deliveryZones: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendorId !== vendorId)
      return res
        .status(400)
        .json({ message: "Branch does not belong to this vendor" });

    const zone = branch.deliveryZones.find(
      (z: any) => z.area === deliveryAddress.area,
    );
    if (!zone)
      return res.status(400).json({
        message: `No delivery zone set up for area: ${deliveryAddress.area}`,
      });

    let subtotal = 0;
    const enrichedItems: {
      menuItemId: string;
      name: string;
      price: number;
      quantity: number;
    }[] = [];

    for (const reqItem of items as { menuItemId: string; quantity: number }[]) {
      const menuItem = await prisma.menuItem.findUnique({
        where: { id: reqItem.menuItemId },
      });
      if (!menuItem)
        return res
          .status(404)
          .json({ message: `Menu item not found: ${reqItem.menuItemId}` });
      if (menuItem.branchId !== branchId)
        return res
          .status(400)
          .json({ message: `${menuItem.name} does not belong to this branch` });
      if (!menuItem.isAvailable)
        return res
          .status(400)
          .json({ message: `${menuItem.name} is currently unavailable` });

      enrichedItems.push({
        menuItemId: menuItem.id,
        name: menuItem.name,
        price: menuItem.price, // snapshot — future price edits will NOT affect this order
        quantity: reqItem.quantity,
      });
      subtotal += menuItem.price * reqItem.quantity;
    }

    const deliveryFee = zone.deliveryFee;
    const transactionFee = subtotal * (config.transactionFeePercent / 100);
    const totalAmount = subtotal + deliveryFee + transactionFee;

    // After validating items, before creating order:
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });

    if (paymentMethod === "pay_on_delivery" && !vendor!.allowsPayOnDelivery) {
      return res
        .status(400)
        .json({ message: "This vendor does not accept pay on delivery" });
    }

    const transactionRef = generateUUID();
    const lockClientId = clientRequestId || transactionRef;

    const lock = await WalletService.lockFundsForOrder({
      userId,
      amount: totalAmount,
      clientRequestId: lockClientId,
      metaData: {
        finalAmountToPay: totalAmount,
        productName: "Product Purchase",
        direction: "debit",
        transactionID: "",
      },
    });

    if (lock.idempotent) {
      const transactionStatus = prismaTransactionStatusToApi(
        lock.transaction.status,
      );
      return res.json(
        withTransactionStatus(
          { ...lock.transaction } as Record<string, unknown>,
          transactionStatus,
          { omitStatus: true },
        ),
      );
    }

    const order = await prisma.order.create({
      data: {
        userId,
        userName: user?.name?.split(" ")[0] || "User",
        vendorId,
        branchId,
        subtotal,
        deliveryFee,
        transactionFee,
        totalAmount,
        status: "pending",
        escrowStatus: paymentMethod == "pay_on_delivery" ? "noEscrow" : "held",
        paymentMethod,
        deliveryState: deliveryAddress.state,
        deliveryLga: deliveryAddress.lga,
        deliveryArea: deliveryAddress.area,
        deliveryStreet: deliveryAddress.street,
        vendorName: branch.vendor.name,
        vendorLogo: branch.vendor.logo,
        branchName: `${branch.area}, ${branch.lga}`,
        items: { create: enrichedItems },
      },
      include: { items: true },
    });

    await prisma.transaction.update({
      where: { id: lock.transaction.id },
      data: {
        orderId: order.id,
      },
    });

    const commission = subtotal * (config.commissionPercent / 100);

    if (paymentMethod !== "pay_on_delivery") {
      await prisma.escrow.create({
        data: {
          orderId: order.id,
          amountHeld: totalAmount,
          commission,
          releaseStatus: "held",
          autoReleaseAt: new Date(
            Date.now() + config.autoReleaseHours * 60 * 60 * 1000,
          ),
        },
      });
    }

    const chatRef = admin.firestore().collection("orderChats").doc(order.id);

    try {
      await chatRef.set(
        {
          participants: FieldValue.arrayUnion(userId, vendorId),
          isAppealed: false,
          isClosed: false,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (err) {
      console.error("Chat creation failed:", err);
    }

    if (notificationToken) {
      await sendNotification(
        notificationToken,
        "New Order Created",
        `You have a new order worth ₦${totalAmount}`,
      );
    }

    res
      .status(201)
      .json(
        withTransactionStatus(
          { ...order } as Record<string, unknown>,
          "PENDING",
          { omitStatus: true },
        ),
      );
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getMyOrders = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { status } = req.query;

    const orders = await prisma.order.findMany({
      where: { userId, ...(status && { status: status as any }) },
      include: { items: true },
      orderBy: { createdAt: "desc" },
    });

    res.json(orders);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getOrderById = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, escrow: true },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.userId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    res.json(order);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const confirmDelivery = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.userId !== userId)
      return res.status(403).json({ message: "Unauthorized" });
    if (order.status !== "delivered")
      return res
        .status(400)
        .json({ message: "Order is not in delivered state" });

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { status: "completed", escrowStatus: "released" },
      include: { items: true },
    });

    await prisma.escrow.update({
      where: { orderId },
      data: { releaseStatus: "released", releasedAt: new Date() },
    });

    await recalculateVendorMetrics(order.vendorId);

    const vendor = await prisma.vendor.findUnique({
      where: { id: order.vendorId },
      include: { user: true },
    });

    await WalletService.creditAvailableBalance({
      userId: vendor!.ownerId,
      amount: order.totalAmount,
    });
    await WalletService.createCreditTransaction({
      userId: vendor!.ownerId,
      amount: order.totalAmount,
      type: "ORDER COMPLETED",
      metaData: { orderId, vendorId: vendor!.id },
    });

    await WalletService.releaseEscow({
      userId: userId,
      amount: order.totalAmount,
      orderId: order.id,
    });

    if (vendor)
      await notify(
        vendor.user.notificationToken!,
        "ORDER COMPLETED",
        "Your order has been completed and payment released to your wallet.",
      );
    const user = await prisma.user.findUnique({
      where: { id: order.userId },
      select: { notificationToken: true },
    });
    if (user) {
      await notify(
        user.notificationToken!,
        "ORDER COMPLETED",
        "Your order has been completed and payment has been released to the counterparty.",
      );
    }

    res.json(updated);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const appealOrder = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { branch: true },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.userId !== userId && order.branch.managerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    // With this:
    const appealableStatuses = [
      "delivered",
      "confirmed",
      "preparing",
      "outForDelivery",
    ];
    if (!appealableStatuses.includes(order.status)) {
      return res.status(400).json({ message: "Cannot appeal this order" });
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { status: "appealed", escrowStatus: "appealed" },
      include: { items: true },
    });

    await prisma.escrow.update({
      where: { orderId },
      data: {
        releaseStatus: "appealed",
        appealReason: reason,
        autoReleaseAt: new Date("2099-01-01"), // freeze — admin must resolve
      },
    });

    const customerSupport = await prisma.user.findFirst({
      where: { role: "admin" },
    });

    const chatRef = admin.firestore().collection("orderChats").doc(order.id);

    await chatRef.set(
      {
        participants: FieldValue.arrayUnion(customerSupport?.firebaseUid),
        isAppeald: true,
      },
      { merge: true },
    );

    await admin.firestore().collection("adminNotifications").add({
      type: "ORDER_APPEALED",
      orderId,
      reason,
      userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json(updated);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getManagerOrders = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { status } = req.query;

    const branches = await prisma.branch.findMany({
      where: { managerId: userId },
    });

    if (!branches) return res.status(404).json({ message: "Branch not found" });

    const orders = await prisma.order.findMany({
      where: {
        branch: {
          managerId: userId,
        },
        ...(status && { status: status as any }),
      },
      include: { items: true },
      orderBy: { createdAt: "desc" },
    });

    res.json(orders);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const updateOrderStatus = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;
    const { status } = req.body;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const branch = await prisma.branch.findFirst({
      where: { managerId: userId },
    });

    if (!branch) return res.status(403).json({ message: "Unauthorized" });

    const allowed: Record<string, string[]> = {
      pending: ["confirmed", "cancelled"],
      confirmed: ["preparing"],
      preparing: ["outForDelivery"],
      outForDelivery: ["delivered"],
    };

    if (!allowed[order.status]?.includes(status)) {
      return res.status(400).json({
        message: `Cannot change status from ${order.status} to ${status}`,
      });
    }

    let updated: Order;

    if (status === "cancelled") {
      await prisma.escrow.update({
        where: { orderId },
        data: { releaseStatus: "refunded", refundedAt: new Date() },
      });

      updated = await prisma.order.update({
        where: { id: orderId },
        data: { escrowStatus: "refunded", updatedAt: new Date(), status },
        include: { items: true },
      });

      await WalletService.moveLockedToAvailableCredit({
        userId: updated.userId,
        amount: order.totalAmount,
      });
      await WalletService.createCreditTransaction({
        userId: updated.userId,
        amount: order.totalAmount,
        type: "ORDER_CANCEL_REFUND",
        metaData: { orderId, vendorId: order.vendorId },
      });

      await recalculateVendorMetrics(order.vendorId);
    }

    updated = await prisma.order.update({
      where: { id: orderId },
      data: { status },
      include: { items: true },
    });

    const user = await prisma.user.findUnique({
      where: { id: order.userId },
      select: { notificationToken: true },
    });

    if (user?.notificationToken) {
      await notify(
        user.notificationToken,
        "Order Status Updated",
        "Your order status has been updated.",
      );
    }

    res.json(updated);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const cancelAppeal = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { branch: true },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.userId !== userId && order.branch.managerId !== userId)
      return res.status(403).json({ message: "Forbidden" });
    if (order.status !== "appealed")
      return res.status(400).json({ message: "Order is not under appeal" });

    // Restore auto-release window from now
    const config = await prisma.appConfig.findFirst();
    const hours = config?.autoReleaseHours ?? 24;
    const autoReleaseAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    await prisma.order.update({
      where: { id: orderId },
      data: { status: "delivered" },
    });
    await prisma.escrow.update({
      where: { orderId },
      data: { releaseStatus: "held", autoReleaseAt },
    });

    res.json({ message: "Appeal cancelled. Escrow timer restored." });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const confirmPodReceived = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ message: "Not found" });
    if (order.paymentMethod !== "pay_on_delivery")
      return res.status(400).json({ message: "Not a POD order" });
    if (order.status !== "delivered")
      return res.status(400).json({ message: "Order not delivered yet" });

    const config = await prisma.appConfig.findFirst();
    const commissionPercent = config?.commissionPercent ?? 5;
    const commission = order.subtotal * (commissionPercent / 100);

    // Mark POD confirmed and deduct commission
    // Commission is owed — log it for reconciliation
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "completed", podConfirmed: true },
    });

    // Log commission debt (you collect this separately)
    await admin.firestore().collection("podCommissions").add({
      orderId: order.id,
      vendorId: order.vendorId,
      subtotal: order.subtotal,
      commission,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      message: "POD confirmed. Commission due: ₦" + commission.toFixed(2),
    });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
  placeOrder,
  getMyOrders,
  getOrderById,
  confirmDelivery,
  appealOrder,
  getManagerOrders,
  updateOrderStatus,
  cancelAppeal,
  confirmPodReceived,
};
