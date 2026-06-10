import { prisma } from "../../../prisma";
import { decodeCursor, parseLimit, buildPage } from "../utils/pagination";

const addMenuItem = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { branchId } = req.params;
    const { name, description, price, isAvailable, imageUrls } = req.body;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { vendor: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendor.ownerId !== userId && branch.managerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    const item = await prisma.menuItem.create({
      data: {
        branchId,
        name,
        description,
        price,
        isAvailable: isAvailable !== undefined ? isAvailable : true,
        ...(imageUrls !== undefined && { images: imageUrls }),
      },
    });

    res.status(201).json(item);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const updateMenuItem = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { itemId } = req.params;
    const { name, description, price, isAvailable, imageUrls} = req.body;

    const item = await prisma.menuItem.findUnique({
      where: { id: itemId },
      include: { branch: { include: { vendor: true } } },
    });
    if (!item) return res.status(404).json({ message: "Menu item not found" });
    if (item.branch.vendor.ownerId !== userId && item.branch.managerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    // Price update here does NOT affect existing orders.
    // Each order stores a price snapshot at the time of placement.
    const updated = await prisma.menuItem.update({
      where: { id: itemId },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(price !== undefined && { price }),
        ...(isAvailable !== undefined && { isAvailable }),
         ...(imageUrls !== undefined && { images: imageUrls }),
      },
    });

    res.json(updated);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const deleteMenuItem = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { itemId } = req.params;

    const item = await prisma.menuItem.findUnique({
      where: { id: itemId },
      include: { branch: { include: { vendor: true } } },
    });
    if (!item) return res.status(404).json({ message: "Menu item not found" });
    if (item.branch.vendor.ownerId !== userId && item.branch.managerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    await prisma.menuItem.delete({ where: { id: itemId } });
    res.json({ success: true });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const toggleMenuItemAvailability = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { itemId } = req.params;

    const item = await prisma.menuItem.findUnique({
      where: { id: itemId },
      include: { branch: { include: { vendor: true } } },
    });
    if (!item) return res.status(404).json({ message: "Menu item not found" });
    if (item.branch.vendor.ownerId !== userId && item.branch.managerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    const updated = await prisma.menuItem.update({
      where: { id: itemId },
      data: { isAvailable: !item.isAvailable },
    });

    res.json({ isAvailable: updated.isAvailable });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getManagerBranchesMenu = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { cursor, limit } = req.query;

    const take = parseLimit(limit, 50, 100);
    const decoded = decodeCursor(cursor);

    const rows = await prisma.menuItem.findMany({
      where: { branch: { managerId: userId } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: take + 1,
      ...(decoded ? { cursor: { id: decoded.id }, skip: 1 } : {}),
    });

    res.json(buildPage(rows, take));
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
  addMenuItem,
  updateMenuItem,
  deleteMenuItem,
  toggleMenuItemAvailability,
  getManagerBranchesMenu,
};
