import { prisma } from "../../../prisma";
import admin from "firebase-admin";

const addMenuItem = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { branchId } = req.params;
    const { name, description, price, isAvailable } = req.body;

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
        imageUrl: "",
        isAvailable: isAvailable !== undefined ? isAvailable : true,
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
    const { name, description, price, isAvailable } = req.body;

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
    
    const menuItems = await prisma.menuItem.findMany({
      where: {
        branch: {
          managerId: userId
        },
      },
       orderBy: { createdAt: "desc" },
    });

    res.json(menuItems);
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
