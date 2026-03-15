import { checkAuth } from "../../webhook/utils/auth";
import { prisma } from "../../prisma";


const getBranchMenu = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const { branchId } = req.params;

    const items = await prisma.menuItem.findMany({
      where: { branchId },
      orderBy: { createdAt: "asc" },
    });

    res.json(items);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getDeliveryZones = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const { branchId } = req.params;

    const zones = await prisma.deliveryZone.findMany({ where: { branchId } });
    res.json(zones);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const addBranch = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);

    const { state, lga, area, street, estimatedDeliveryTime } = req.body;

    const vendor = await prisma.vendor.findFirst({
      where: { ownerId: userId },
    });

    if (!vendor) return res.status(404).json({ message: "Vendor not found" });
    
    if (vendor.status !== "approved")
      return res.status(403).json({ message: "Vendor is not approved" });

    const branch = await prisma.branch.create({
      data: {
        vendorId: vendor.id,
        state,
        lga,
        area,
        street,
        estimatedDeliveryTime: estimatedDeliveryTime || 30,
      },
      include: { deliveryZones: true },
    });

    res.status(201).json(branch);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const updateBranch = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);

    const { branchId } = req.params;
    const { state, lga, area, street, estimatedDeliveryTime } = req.body;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { vendor: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendor.ownerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    const updated = await prisma.branch.update({
      where: { id: branchId },
      data: {
        ...(state && { state }),
        ...(lga && { lga }),
        ...(area && { area }),
        ...(street && { street }),
        ...(estimatedDeliveryTime && { estimatedDeliveryTime }),
      },
      include: { deliveryZones: true },
    });

    res.json(updated);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const deleteBranch = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);

    const { branchId } = req.params;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { vendor: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendor.ownerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    const activeOrders = await prisma.order.findMany({
      where: { branchId, status: { notIn: ["completed", "cancelled"] } },
    });
    if (activeOrders.length > 0) {
      return res
        .status(400)
        .json({ message: "Cannot delete a branch that has active orders" });
    }

    await prisma.branch.delete({ where: { id: branchId } });
    res.json({ success: true });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const addDeliveryZone = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);

    const { branchId } = req.params;
    const { state, lga, area, deliveryFee } = req.body;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { vendor: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendor.ownerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    const existing = await prisma.deliveryZone.findFirst({
      where: { branchId, area },
    });
    if (existing)
      return res
        .status(400)
        .json({ message: "A delivery zone for this area already exists" });

    const zone = await prisma.deliveryZone.create({
      data: { branchId, state, lga, area, deliveryFee },
    });

    res.status(201).json(zone);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const deleteDeliveryZone = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);

    const { zoneId } = req.params;

    const zone = await prisma.deliveryZone.findUnique({
      where: { id: zoneId },
      include: { branch: { include: { vendor: true } } },
    });
    if (!zone)
      return res.status(404).json({ message: "Delivery zone not found" });
    if (zone.branch.vendor.ownerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    await prisma.deliveryZone.delete({ where: { id: zoneId } });
    res.json({ success: true });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const setMainBranch = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);
    const { branchId } = req.params;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { vendor: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendor.ownerId !== userId) return res.status(403).json({ message: "Forbidden" });

    // Demote all, promote this one
    await prisma.branch.updateMany({
      where: { vendorId: branch.vendorId },
      data: { isMainBranch: false },
    });
    await prisma.branch.update({
      where: { id: branchId },
      data: { isMainBranch: true },
    });

    res.json({ message: "Main branch updated" });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const assignManager = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);
    const { branchId } = req.params;
    const { managerUid } = req.body;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { vendor: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendor.ownerId !== userId) return res.status(403).json({ message: "Only vendor owner can assign managers" });

    await prisma.branch.update({
      where: { id: branchId },
      data: { managerUid },
    });

    res.json({ message: "Manager assigned" });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
  getBranchMenu,
  getDeliveryZones,
  addBranch,
  updateBranch,
  deleteBranch,
  addDeliveryZone,
  setMainBranch,
  assignManager,
  deleteDeliveryZone,
};
