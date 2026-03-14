import { prisma } from "../../prisma";
import { checkAuth } from "../../webhook/utils/auth";
import admin from "../../webhook/utils/firebase";
import { sendNotification } from "../../webhook/notification";
import { generateUUID } from "../../utils/uuid";
import { Order } from "@prisma/client";

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
    const userId = await checkAuth(req);

    const clientRequestId = "";

    const notificationToken = await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .get()
      .then((doc) => doc.data()?.notificationToken as string | undefined);

    const { vendorId, branchId, items, deliveryAddress } = req.body;

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

    const transactionRef = generateUUID();

    const usersRef = admin.firestore().collection("users");
    const transfersRef = admin.firestore().collection("transfers");
    const transactionsRef = admin.firestore().collection("transactions");

    const userDoc = await usersRef.doc(userId).get();

    // Idempotency check
    const existing = await transfersRef
      .where("clientRequestId", "==", clientRequestId)
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.json(existing.docs[0].data());
    }

    const transferDoc = transfersRef.doc(transactionRef);

    //locked user balance and create transfer record in firestore
    await admin.firestore().runTransaction(async (transaction) => {
      const userDoc = usersRef.doc(userId);

      const userSnap = await transaction.get(userDoc);

      const userBalance = userSnap.data()?.wallet.fiat.availableBalance;
      const wallet = userSnap.data()?.wallet.fiat;
      if (userBalance < totalAmount) {
        throw new Error("Insufficient balance");
      }
      const newUserBalance = userBalance - totalAmount;

      transaction.update(userDoc, {
        "wallet.fiat.availableBalance": newUserBalance,
        "wallet.fiat.lockedBalance": wallet.lockedBalance + totalAmount,
      });
      // User transaction
      transaction.set(transactionsRef.doc(transactionRef), {
        userId: userId,
        transferId: transferDoc.id,
        metaData: {
          finalAmountToPay: totalAmount,
          productName: "Product Purchase",
          direction: "debit",
          transactionID: "",
        },
        type: "wallet",
        clientRequestId,
        amount: totalAmount,
        balanceBefore: userBalance,
        balanceAfter: newUserBalance,
        status: "processing",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    const order = await prisma.order.create({
      data: {
        userId,
        vendorId,
        branchId,
        subtotal,
        deliveryFee,
        transactionFee,
        totalAmount,
        status: "pending",
        escrowStatus: "held",
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

    const commission = subtotal * (config.commissionPercent / 100);
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

    await notify(branch.vendor.ownerId, "NEW_ORDER", {
      orderId: order.id,
      totalAmount,
    });

    if (notificationToken) {
      await sendNotification(
        notificationToken,
        "New Order Created",
        `You have a new order worth ₦${totalAmount}`,
      );
    }

    res.status(201).json(order);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getMyOrders = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);

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
    const userId = await checkAuth(req);

    const { orderId } = req.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, escrow: true },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const vendorOwner = await prisma.vendor.findFirst({
      where: { id: order.vendorId, ownerId: userId },
    });
    if (order.userId !== userId && !vendorOwner)
      return res.status(403).json({ message: "Unauthorized" });

    res.json(order);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const confirmDelivery = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);

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
    });

    await admin.firestore().runTransaction(async (transaction) => {
      const vendorOwnerDoc = admin
        .firestore()
        .collection("users")
        .doc(vendor!.ownerId);
      const vendorOwnerSnap = await transaction.get(vendorOwnerDoc);

      const vendorOwnerBalance =
        vendorOwnerSnap.data()?.wallet.fiat.availableBalance || 0;
      const newVendorOwnerBalance = vendorOwnerBalance + order.totalAmount;

      transaction.update(vendorOwnerDoc, {
        "wallet.fiat.availableBalance": newVendorOwnerBalance,
      });

      // Vendor transaction
      const transactionRef = generateUUID();
      transaction.set(
        admin.firestore().collection("transactions").doc(transactionRef),
        {
          orderId,
          vendorId: vendor!.id,
          userId: vendor!.ownerId,
          amount: order.totalAmount,
          type: "ORDER_COMPLETED",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      );
    });

    if (vendor) await notify(vendor.ownerId, "ORDER_COMPLETED", { orderId });

    res.json(updated);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const appealOrder = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);

    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.userId !== userId)
      return res.status(403).json({ message: "Unauthorized" });
    if (!["delivered", "completed"].includes(order.status)) {
      return res.status(400).json({ message: "This order cannot be appealed" });
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

const getVendorOrders = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);

    const { status } = req.query;

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const orders = await prisma.order.findMany({
      where: { vendorId: vendor.id, ...(status && { status: status as any }) },
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
    const userId = await checkAuth(req);

    const { orderId } = req.params;
    const { status } = req.body;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor || order.vendorId !== vendor.id)
      return res.status(403).json({ message: "Unauthorized" });

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
        data: { escrowStatus: "refunded", updatedAt: new Date(), status  },
        include: { items: true },
      });

      await admin.firestore().runTransaction(async (transaction) => {
        const vendorOwnerDoc = admin
          .firestore()
          .collection("users")
          .doc(updated.userId);
        const vendorOwnerSnap = await transaction.get(vendorOwnerDoc);

        const userOwnerBalance =
          vendorOwnerSnap.data()?.wallet.fiat.availableBalance || 0;
        const newVendorOwnerBalance = userOwnerBalance + order.totalAmount;
        const userLockedBalance = vendorOwnerSnap.data()?.wallet.fiat.lockedBalance || 0;
        const newUserLockedBalance = userLockedBalance - order.totalAmount;

        transaction.update(vendorOwnerDoc, {
          "wallet.fiat.availableBalance": newVendorOwnerBalance,
          "wallet.fiat.lockedBalance": newUserLockedBalance,
        });

        // Vendor transaction
        const transactionRef = generateUUID();
        transaction.set(
          admin.firestore().collection("transactions").doc(transactionRef),
          {
            orderId,
            vendorId: vendor!.id,
            userId: vendor!.ownerId,
            amount: order.totalAmount,
            type: "ORDER_COMPLETED",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        );
      });

      await recalculateVendorMetrics(order.vendorId);
    }


    updated = await prisma.order.update({
      where: { id: orderId },
      data: { status },
      include: { items: true },
    });

   
    await notify(order.userId, "ORDER_STATUS_UPDATED", { orderId, status });

    res.json(updated);
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
  getVendorOrders,
  updateOrderStatus,
};
