// REPO PATH: src/shared/services/revenue.service.ts   (NEW FILE)
//
// Append-only platform-revenue ledger. One row per REALIZED earning, keyed by a
// unique idempotencyKey so the same event can never double-book (safe under
// webhook/retry/cron re-entry).
//
// Design choices that matter:
//  • recordRevenue uses createMany({ skipDuplicates:true }) — on PostgreSQL this
//    silently ignores a duplicate key INSTEAD OF THROWING, so it is safe to call
//    INSIDE the caller's $transaction (a thrown unique-violation would poison the
//    surrounding tx in Postgres). It commits atomically with the money event.
//  • Fail-OPEN: recording revenue must never break the money path that triggers
//    it. Any unexpected error is logged and swallowed; a missing revenue row only
//    under-reports revenue (which the daily reconciliation cross-check surfaces).
//  • Fail-CLOSED on migration: no-ops cleanly until the table exists.

import { Prisma, RevenueSource, RevenueTrack } from "@prisma/client";
import { prisma } from "../../prisma";

type Db = Prisma.TransactionClient | typeof prisma;

// String-literal keys so call-sites pass plain strings (no enum imports needed).
export type RevenueSourceKey =
  | "order_commission" | "pod_commission" | "transaction_fee" | "funding_fee"
  | "utility_markup" | "gift_breakage" | "conversion_spread" | "coin_breakage"
  | "manual_adjustment";
export type RevenueTrackKey = "ngn_float" | "coin";

export interface RecordRevenueInput {
  source: RevenueSourceKey;
  track?: RevenueTrackKey;        // default "ngn_float"
  amount: number;                 // NGN value
  refType?: string;
  refId?: string | null;
  idempotencyKey: string;         // unique — never double-books
  note?: string;
  meta?: Prisma.JsonObject;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Cheap cached probe so we wake up the moment the migration lands (no redeploy).
let _ready: boolean | null = null;
export async function revenueTableReady(): Promise<boolean> {
  if (_ready === true) return true;
  try {
    await prisma.platformRevenue.count();
    _ready = true;
    return true;
  } catch {
    _ready = false;
    return false;
  }
}

export async function recordRevenue(db: Db, input: RecordRevenueInput): Promise<void> {
  try {
    if (!(await revenueTableReady())) return; // pre-migration: skip silently

    const amount = round2(input.amount);
    // Skip zero/negative (meaningless ledger rows) except deliberate adjustments.
    if (amount <= 0 && input.source !== "manual_adjustment") return;

    await db.platformRevenue.createMany({
      data: [
        {
          source: input.source as RevenueSource,
          track: (input.track ?? "ngn_float") as RevenueTrack,
          amount,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          idempotencyKey: input.idempotencyKey,
          note: input.note ?? null,
          meta: input.meta ?? Prisma.JsonNull,
        },
      ],
      skipDuplicates: true, // duplicate idempotencyKey → ignored, never throws
    });
  } catch (e: any) {
    // Non-fatal by contract — log and move on.
    console.error("[revenue.record] non-fatal:", e?.message ?? e);
  }
}

/** Lifetime/range revenue total, optionally by track. */
export async function sumRevenue(opts?: {
  track?: RevenueTrackKey;
  from?: Date;
  to?: Date;
}): Promise<number> {
  if (!(await revenueTableReady())) return 0;
  const range =
    opts?.from || opts?.to
      ? { createdAt: { ...(opts?.from ? { gte: opts.from } : {}), ...(opts?.to ? { lte: opts.to } : {}) } }
      : {};
  const agg = await prisma.platformRevenue.aggregate({
    _sum: { amount: true },
    where: { ...(opts?.track ? { track: opts.track as RevenueTrack } : {}), ...range },
  });
  return agg._sum.amount ?? 0;
}

/** Revenue grouped by (source, track) for the admin summary. */
export async function revenueBySource(opts?: { from?: Date; to?: Date }) {
  if (!(await revenueTableReady())) return [];
  const range =
    opts?.from || opts?.to
      ? { createdAt: { ...(opts?.from ? { gte: opts.from } : {}), ...(opts?.to ? { lte: opts.to } : {}) } }
      : {};
  const rows = await prisma.platformRevenue.groupBy({
    by: ["source", "track"],
    _sum: { amount: true },
    _count: { _all: true },
    where: range,
  });
  return rows.map((r) => ({
    source: r.source,
    track: r.track,
    total: r._sum.amount ?? 0,
    count: r._count._all,
  }));
}