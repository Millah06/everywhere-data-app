// REPO PATH: src/modules/admin/controllers/reconciliation.controller.ts   (NEW FILE)
//
// Admin treasury endpoints. Same controller style as the rest of the admin
// module: `const fn = async (req:any,res:any)`, default-export object,
// `req.user?.id`, `prisma` named export. All routes are mounted behind
// authMiddleware + requireAdmin in admin/routes/routes.ts.

import { prisma } from "../../../prisma";
import { computeReconciliation } from "../../../shared/services/reconciliation.service";
import { revenueBySource, sumRevenue, revenueTableReady } from "../../../shared/services/revenue.service";

const num = (v: any): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * GET /admin/reconciliation/summary
 * Live, read-only computation for the dashboard. Optional query overrides let
 * the admin preview "what if" balances without persisting:
 *   ?opay=..&apple=..&google=..&paystack=..
 */
const getSummary = async (req: any, res: any) => {
  try {
    const result = await computeReconciliation({
      opayBalance: num(req.query.opay),
      bankBalance: num(req.query.bank),
      vtpassBalance: num(req.query.vtpass),
      appleBalance: num(req.query.apple),
      googleBalance: num(req.query.google),
      paystackOverride: num(req.query.paystack),
    });
    return res.json(result);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * POST /admin/reconciliation/snapshot
 * Compute + PERSIST a snapshot. The admin supplies the externally-known
 * balances (OPay, Apple, Google); Paystack is auto-fetched unless overridden.
 * Body: { opayBalance?, appleBalance?, googleBalance?, paystackOverride?, note? }
 */
const takeSnapshot = async (req: any, res: any) => {
  try {
    const { opayBalance, bankBalance, vtpassBalance, appleBalance, googleBalance, paystackOverride, note } =
      req.body ?? {};
    const r = await computeReconciliation({
      opayBalance: num(opayBalance),
      bankBalance: num(bankBalance),
      vtpassBalance: num(vtpassBalance),
      appleBalance: num(appleBalance),
      googleBalance: num(googleBalance),
      paystackOverride: num(paystackOverride),
    });

    const saved = await prisma.reconciliationSnapshot.create({
      data: {
        takenBy: req.user?.id ?? null,
        ngnLiabilities: r.ngn.liabilities,
        ngnFloat: r.ngn.float,
        ngnSurplus: r.ngn.surplus,
        ngnStatus: r.ngn.status,
        coinLiability: r.coin.coinLiability,
        coinFunding: r.coin.funding,
        coinSurplus: r.coin.surplus,
        coinStatus: r.coin.status,
        paystackBalance: r.ngn.paystackBalance,
        opayBalance: r.ngn.opayBalance,
        bankBalance: r.ngn.bankBalance,
        vtpassBalance: r.ngn.vtpassBalance,
        appleBalance: r.coin.appleBalance,
        googleBalance: r.coin.googleBalance,
        paystackFetchOk: r.ngn.paystackFetchOk,
        figures: r as any, // full itemized breakdown
        note: note ?? null,
      },
    });

    return res.json({ snapshot: saved, computed: r });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /admin/reconciliation/history?limit=30
 * Recent snapshots (newest first) for the trend view.
 */
const getHistory = async (req: any, res: any) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "30"), 10) || 30, 1), 100);
    const rows = await prisma.reconciliationSnapshot.findMany({
      orderBy: { takenAt: "desc" },
      take: limit,
    });
    return res.json(rows);
  } catch (e: any) {
    // Pre-migration: empty history rather than a 500.
    return res.json([]);
  }
};

/**
 * GET /admin/revenue/summary?from=ISO&to=ISO
 * Revenue grouped by source + per-track totals.
 */
const getRevenueSummary = async (req: any, res: any) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;
    const [bySource, ngnTotal, coinTotal] = await Promise.all([
      revenueBySource({ from, to }),
      sumRevenue({ track: "ngn_float", from, to }),
      sumRevenue({ track: "coin", from, to }),
    ]);
    return res.json({
      bySource,
      totals: { ngn_float: ngnTotal, coin: coinTotal, all: ngnTotal + coinTotal },
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /admin/revenue/ledger?cursor=<id>&limit=30&track=&source=
 * Cursor-paginated revenue rows (Phase 8 convention: take+1 to detect nextCursor).
 */
const getRevenueLedger = async (req: any, res: any) => {
  try {
    if (!(await revenueTableReady())) return res.json({ items: [], nextCursor: null });
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "30"), 10) || 30, 1), 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const track = req.query.track ? String(req.query.track) : undefined;
    const source = req.query.source ? String(req.query.source) : undefined;

    const rows = await prisma.platformRevenue.findMany({
      where: { ...(track ? { track: track as any } : {}), ...(source ? { source: source as any } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return res.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default {
  getSummary,
  takeSnapshot,
  getHistory,
  getRevenueSummary,
  getRevenueLedger,
};