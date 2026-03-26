import { prisma } from "../../../prisma";
import admin from "firebase-admin";
import { requireMainBranch } from "../branch/branchAuth";

const getVendors = async (req: any, res: any) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { vendorType, state, lga, search, sortBy } = req.query;

    const where: any = { status: "approved", isVisible: true };
    if (vendorType) where.vendorType = vendorType;
    if (search) where.name = { contains: search, mode: "insensitive" };
    if (state || lga) {
      where.branches = {
        some: { ...(state && { state }), ...(lga && { lga }) },
      };
    }

    const vendors = await prisma.vendor.findMany({
      where,
      include: { branches: { include: { deliveryZones: true } } },
    });

    const maxOrders = Math.max(
      ...vendors.map((v: any) => v.totalCompletedOrders as number),
      1,
    );

    const sorted = vendors.sort((a: any, b: any) => {
      if (sortBy === "completionRate")
        return b.completionRate - a.completionRate;
      if (sortBy === "totalCompletedOrders")
        return b.totalCompletedOrders - a.totalCompletedOrders;
      const scoreA =
        (a.rating / 5) * 0.5 +
        (a.completionRate / 100) * 0.3 +
        (a.totalCompletedOrders / maxOrders) * 0.2;
      const scoreB =
        (b.rating / 5) * 0.5 +
        (b.completionRate / 100) * 0.3 +
        (b.totalCompletedOrders / maxOrders) * 0.2;
      return scoreB - scoreA;
    });

    res.json(sorted);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getVendorById = async (req: any, res: any) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;

    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: {
        branches: { include: { deliveryZones: true } },
        reviews: true,
      },
    });

    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    res.json(vendor);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getMyVendor = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
      include: { branches: { include: { deliveryZones: true } } },
    });

    if (!vendor) return res.status(404).json({ message: "Not a vendor" });

    res.json(vendor);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const updateProfile = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { description, phone, email } = req.body;

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const updated = await prisma.vendor.update({
      where: { id: vendor.id },
      data: { description, phone, email },
    });

    res.json(updated);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const applyAsVendor = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { name, vendorType, description, phone, email, cac, branch } =
      req.body;

    const existing = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (existing) {
      if (existing.status == "rejected") {
        const vendor = await prisma.vendor.update({
          where: {
            id: existing.id,
          },
          data: {
            ownerId: userId,
            ownerFirebaseUid: req.user.uid,
            name,
            vendorType,
            description,
            phone: phone || "",
            email: email || "",
            cac: cac || "",
            //will be change on production to pending and only set to approved after admin review
            status: "pending",
            isVisible: false,
            ...(branch && {
              branches: {
                create: {
                  isMainBranch: true,
                  managerId: userId,
                  managerUid: req.user.uid,
                  state: branch.state,
                  lga: branch.lga,
                  area: branch.area,
                  street: branch.street,
                  estimatedDeliveryTime: branch.estimatedDeliveryTime || 30,
                },
              },
            }),
          },
          include: { branches: true },
        });

        await admin.firestore().collection("adminNotifications").add({
          type: "NEW_VENDOR_RESUBMISSION_APPLICATION",
          vendorId: vendor.id,
          vendorName: vendor.name,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.status(201).json(vendor);
      }

      return res
        .status(400)
        .json({ message: "You have already applied as a vendor" });
    }

    const vendor = await prisma.vendor.create({
      data: {
        ownerId: userId,
        ownerFirebaseUid: req.user.uid,
        name,
        vendorType,
        description,
        phone: phone || "",
        email: email || "",
        cac: cac || "",
        //will be change on production to pending and only set to approved after admin review
        status: "pending",
        isVisible: false,
        ...(branch && {
          branches: {
            create: {
              isMainBranch: true,
              managerId: userId,
              managerUid: req.user.uid,
              state: branch.state,
              lga: branch.lga,
              area: branch.area,
              street: branch.street,
              estimatedDeliveryTime: branch.estimatedDeliveryTime || 30,
            },
          },
        }),
      },
      include: { branches: true },
    });

    await admin.firestore().collection("adminNotifications").add({
      type: "NEW_VENDOR_APPLICATION",
      vendorId: vendor.id,
      vendorName: vendor.name,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json(vendor);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getVendorMetrics = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    const orders = await prisma.order.findMany({
      where: { vendorId: vendor.id },
    });
    const escrows = await prisma.escrow.findMany({
      where: { order: { vendorId: vendor.id } },
    });

    const completed = orders.filter((o: any) => o.status === "completed");
    const totalRevenue = completed.reduce(
      (sum: number, o: any) => sum + o.subtotal,
      0,
    );
    const pendingEscrow = escrows
      .filter((e: any) => e.releaseStatus === "held")
      .reduce((sum: number, e: any) => sum + e.amountHeld, 0);
    const releasedEarnings = escrows
      .filter((e: any) => e.releaseStatus === "released")
      .reduce((sum: number, e: any) => sum + (e.amountHeld - e.commission), 0);

    res.json({
      totalCompletedOrders: completed.length,
      completionRate:
        orders.length > 0
          ? Math.round((completed.length / orders.length) * 100)
          : 100,
      totalRevenue,
      pendingEscrow,
      releasedEarnings,
      rating: vendor.rating,
    });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const toggleVisibility = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });
    if (vendor.status !== "approved")
      return res.status(400).json({ message: "Vendor is not approved yet" });

    const updated = await prisma.vendor.update({
      where: { id: vendor.id },
      data: { isVisible: !vendor.isVisible },
    });

    res.json({ isVisible: updated.isVisible });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const togglePodAcceptance = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });
    if (vendor.status !== "approved")
      return res.status(400).json({ message: "Vendor is not approved yet" });

    const updated = await prisma.vendor.update({
      where: { id: vendor.id },
      data: { allowsPayOnDelivery: !vendor.allowsPayOnDelivery },
    });

    res.json({ allowsPayOnDelivery: updated.allowsPayOnDelivery });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const addReview = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { id: vendorId } = req.params;
    const { rating, comment } = req.body;

    if (rating < 1 || rating > 5)
      return res
        .status(400)
        .json({ message: "Rating must be between 1 and 5" });

    const completedOrder = await prisma.order.findFirst({
      where: { userId, vendorId, status: "completed" },
    });
    if (!completedOrder)
      return res
        .status(403)
        .json({ message: "You must complete an order before reviewing" });

    const alreadyReviewed = await prisma.review.findFirst({
      where: { userId, vendorId },
    });
    if (alreadyReviewed)
      return res
        .status(400)
        .json({ message: "You have already reviewed this vendor" });

    const review = await prisma.review.create({
      data: { vendorId, userId, rating, comment },
    });

    const allReviews = await prisma.review.findMany({ where: { vendorId } });
    const avg =
      allReviews.reduce((sum: number, r: any) => sum + r.rating, 0) /
      allReviews.length;

    await prisma.vendor.update({
      where: { id: vendorId },
      data: { rating: Math.round(avg * 10) / 10 },
    });

    res.status(201).json(review);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getAdvancedMetrics = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const vendor = await requireMainBranch(userId, req.query.vendorId);

    const orders = await prisma.order.findMany({
      where: { vendorId: vendor.id },
      include: { items: true, escrow: true },
    });

    const completed = orders.filter((o: any) => o.status === "completed");
    const cancelled = orders.filter((o: any) => o.status === "cancelled");
    const appealed = orders.filter((o: any) => o.status === "appealed");
    const ongoing = orders.filter(
      (o: any) => !["completed", "cancelled"].includes(o.status),
    );

    const totalRevenue = completed.reduce(
      (s: number, o: any) => s + o.subtotal,
      0,
    );
    const totalCommission = completed
      .filter((o: any) => o.escrow)
      .reduce((s: number, o: any) => s + (o.escrow?.commission ?? 0), 0);
    const netEarnings = totalRevenue - totalCommission;

    // Per-branch breakdown
    const branches = await prisma.branch.findMany({
      where: { vendorId: vendor.id },
    });
    const branchBreakdown = await Promise.all(
      branches.map(async (b: any) => {
        const bOrders = completed.filter((o: any) => o.branchId === b.id);
        return {
          branchId: b.id,
          area: b.area,
          lga: b.lga,
          isMainBranch: b.isMainBranch,
          completedOrders: bOrders.length,
          revenue: bOrders.reduce((s: number, o: any) => s + o.subtotal, 0),
        };
      }),
    );

    // Top items across all branches
    const allItems = completed.flatMap((o: any) => o.items);
    const itemCounts: Record<
      string,
      { name: string; qty: number; revenue: number }
    > = {};
    for (const item of allItems) {
      if (!itemCounts[item.menuItemId]) {
        itemCounts[item.menuItemId] = { name: item.name, qty: 0, revenue: 0 };
      }
      itemCounts[item.menuItemId].qty += item.quantity;
      itemCounts[item.menuItemId].revenue += item.price * item.quantity;
    }
    const topItems = Object.values(itemCounts)
      .sort((a: any, b: any) => b.qty - a.qty)
      .slice(0, 5);

    res.json({
      summary: {
        totalOrders: orders.length,
        completedOrders: completed.length,
        cancelledOrders: cancelled.length,
        appealedOrders: appealed.length,
        ongoingOrders: ongoing.length,
        totalRevenue,
        totalCommission,
        netEarnings,
        rating: vendor.rating,
        completionRate: vendor.completionRate,
      },
      branchBreakdown,
      topItems,
    });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const requestVerification = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });
    if (vendor.verified)
      return res.status(400).json({ message: "Already verified" });
    if (vendor.status !== "approved")
      return res.status(400).json({ message: "Vendor must be approved first" });

    // Debit verification fee from user wallet
    // Replace with your actual wallet debit logic:
    // await walletService.debit(userId, 2500, "Vendor verification fee");

    // Notify admin
    await admin.firestore().collection("adminNotifications").add({
      type: "VERIFICATION_REQUEST",
      vendorId: vendor.id,
      vendorName: vendor.name,
      ownerId: userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      message:
        "Verification request submitted. Our team will review within 1–3 business days.",
    });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
  getVendors,
  getVendorById,
  getMyVendor,
  applyAsVendor,
  getVendorMetrics,
  toggleVisibility,
  addReview,
  updateProfile,
  getAdvancedMetrics,
  togglePodAcceptance,
  requestVerification,
};
