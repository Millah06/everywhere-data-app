// src/modules/marketPlace/table/tableController.ts
//
// PHASE 7 — DINE-IN
//
// Restaurant table management for merchants + the public dine-in landing read.
// A dine-in order is just an Order with fulfillmentType="dine_in"; it pays and
// settles through the same placeOrder + PaymentSheet path, so nothing here
// touches money.
//
import { prisma } from "../../../prisma";
import { OrderStatus } from "@prisma/client";

// Statuses that count as "still at the table" — a table with any of these
// active orders cannot be deleted. Typed as the real Prisma enum so the
// `{ in: ... }` filter type-checks (no string[] cast needed).
const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.pending,
  OrderStatus.confirmed,
  OrderStatus.preparing,
  OrderStatus.outForDelivery,
  OrderStatus.delivered,
  OrderStatus.pendingFundRelease,
  OrderStatus.appealed,
];

// ── POST /tables/create ───────────────────────────────────────────────────
// body: { branchId, tableNumber, capacity? }
const createTable = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { branchId, tableNumber, capacity } = req.body;

    if (!branchId || !tableNumber)
      return res
        .status(400)
        .json({ message: "branchId and tableNumber are required" });

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { vendor: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendor.ownerId !== userId && branch.managerId !== userId)
      return res.status(403).json({ message: "You do not manage this branch" });

    // Friendly handling of the @@unique([branchId, tableNumber]) constraint.
    const existing = await prisma.restaurantTable.findFirst({
      where: { branchId, tableNumber: String(tableNumber) },
    });
    if (existing)
      return res
        .status(409)
        .json({ message: `Table "${tableNumber}" already exists at this branch` });

    const table = await prisma.restaurantTable.create({
      data: {
        vendorId: branch.vendorId,
        branchId,
        tableNumber: String(tableNumber),
        capacity: capacity != null ? Number(capacity) : 4,
      },
    });

    res.status(201).json(table);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

// ── GET /tables/:vendorId/:branchId ─────────────────────────────────────────
// Merchant-facing list for a branch, numeric-aware sorted.
const listTables = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { branchId } = req.params;

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { vendor: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendor.ownerId !== userId && branch.managerId !== userId)
      return res.status(403).json({ message: "You do not manage this branch" });

    const tables = await prisma.restaurantTable.findMany({
      where: { branchId },
      orderBy: { createdAt: "asc" },
    });

    tables.sort((a, b) => {
      const na = parseInt(a.tableNumber, 10);
      const nb = parseInt(b.tableNumber, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.tableNumber.localeCompare(b.tableNumber);
    });

    res.json(tables);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

// ── PUT /tables/:tableId ─────────────────────────────────────────────────────
// body: { tableNumber?, capacity?, isActive? }
const updateTable = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { tableId } = req.params;
    const { tableNumber, capacity, isActive } = req.body;

    const table = await prisma.restaurantTable.findUnique({
      where: { id: tableId },
    });
    if (!table) return res.status(404).json({ message: "Table not found" });

    const branch = await prisma.branch.findUnique({
      where: { id: table.branchId },
      include: { vendor: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendor.ownerId !== userId && branch.managerId !== userId)
      return res.status(403).json({ message: "You do not manage this table" });

    // Keep per-branch uniqueness on rename.
    if (tableNumber != null && String(tableNumber) !== table.tableNumber) {
      const clash = await prisma.restaurantTable.findFirst({
        where: { branchId: table.branchId, tableNumber: String(tableNumber) },
      });
      if (clash)
        return res
          .status(409)
          .json({ message: `Table "${tableNumber}" already exists at this branch` });
    }

    const updated = await prisma.restaurantTable.update({
      where: { id: tableId },
      data: {
        ...(tableNumber != null ? { tableNumber: String(tableNumber) } : {}),
        ...(capacity != null ? { capacity: Number(capacity) } : {}),
        ...(isActive != null ? { isActive: Boolean(isActive) } : {}),
      },
    });

    res.json(updated);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

// ── DELETE /tables/:tableId ──────────────────────────────────────────────────
// Blocked while the table has any active (not completed/cancelled) order.
const deleteTable = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { tableId } = req.params;

    const table = await prisma.restaurantTable.findUnique({
      where: { id: tableId },
    });
    if (!table) return res.status(404).json({ message: "Table not found" });

    const branch = await prisma.branch.findUnique({
      where: { id: table.branchId },
      include: { vendor: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendor.ownerId !== userId && branch.managerId !== userId)
      return res.status(403).json({ message: "You do not manage this table" });

    const activeCount = await prisma.order.count({
      where: { tableId, status: { in: ACTIVE_ORDER_STATUSES } },
    });
    if (activeCount > 0)
      return res.status(409).json({
        message:
          "This table has active orders. Complete or cancel them before deleting it.",
      });

    await prisma.restaurantTable.delete({ where: { id: tableId } });
    res.json({ success: true });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

// ── GET /tables/:tableId/qr ──────────────────────────────────────────────────
// Returns the canonical deep-link the QR encodes (image is rendered client-side).
const getTableQr = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { tableId } = req.params;

    const table = await prisma.restaurantTable.findUnique({
      where: { id: tableId },
    });
    if (!table) return res.status(404).json({ message: "Table not found" });

    const branch = await prisma.branch.findUnique({
      where: { id: table.branchId },
      include: { vendor: true },
    });
    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendor.ownerId !== userId && branch.managerId !== userId)
      return res.status(403).json({ message: "You do not manage this table" });

    const webBase = process.env.WEB_BASE_URL || "https://amril.app";
    const url = `${webBase}/store/${table.vendorId}/table/${table.id}`;

    res.json({
      url,
      tableId: table.id,
      vendorId: table.vendorId,
      branchId: table.branchId,
      tableNumber: table.tableNumber,
    });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

// ── GET /web/store/:vendorId/table/:tableId  (optionalAuthMiddleware) ─────────
// PUBLIC dine-in landing read. MUST NOT 401 on guests. 404s if the store is
// hidden or the table is missing/inactive.
const getTablePublic = async (req: any, res: any) => {
  try {
    const { vendorId, tableId } = req.params;

    const table = await prisma.restaurantTable.findFirst({
      where: { id: tableId, vendorId, isActive: true },
    });
    if (!table) return res.status(404).json({ message: "Table not available" });

    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, isVisible: true, status: "approved" },
      include: { branches: { include: { menuItems: true } } },
    });
    if (!vendor) return res.status(404).json({ message: "Store not available" });

    // Menu hangs off branches (Branch.menuItems) — aggregate available items.
    const items = vendor.branches
      .flatMap((b) => b.menuItems)
      .filter((m) => m.isAvailable)
      .map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        price: m.price,
        images: m.images,
        branchId: m.branchId,
      }));

    res.json({
      table: {
        id: table.id,
        tableNumber: table.tableNumber,
        vendorId: table.vendorId,
        branchId: table.branchId,
        capacity: table.capacity,
      },
      store: {
        id: vendor.id,
        name: vendor.name,
        description: vendor.description,
        logo: vendor.logo,
        coverPhoto: vendor.coverPhoto,
        rating: vendor.rating,
        verified: vendor.verified,
        vendorType: vendor.vendorType,
        fulfillmentTypes: (vendor as any).fulfillmentTypes ?? ["delivery"],
      },
      items,
    });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
  createTable,
  listTables,
  updateTable,
  deleteTable,
  getTableQr,
  getTablePublic,
};