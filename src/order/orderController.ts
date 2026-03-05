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
      return res
        .status(400)
        .json({
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
      return res
        .status(400)
        .json({
          message: `Cannot change status from ${order.status} to ${status}`,
        });
    }

    const updated = await prisma.order.update({
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
