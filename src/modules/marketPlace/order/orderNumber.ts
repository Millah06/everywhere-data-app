// src/modules/marketPlace/order/orderNumber.ts
//
// PHASE 7 — DINE-IN
//
// Generates the human-facing kitchen order number: a 4-digit number (1000–9999)
// that resets every day, scoped PER BRANCH. This is what the customer sees as
// "#4827" and the kitchen sees as "#4827 — Table 5". It is intentionally short
// and local so it's easy to call out across a counter; the real primary key
// (Order.id, a uuid) is unchanged and remains the source of truth.
//
// Storage: the `DailyOrderCounter` model — one row per (branchId, date) with a
// monotonically increasing `counter`. We rely on a single atomic
// `upsert + { increment: 1 }` so concurrent orders never collide on the same
// number (last-writer-wins is impossible here: increment is computed in the DB).
//
// Day boundary: computed in Africa/Lagos so the daily reset lines up with the
// merchant's actual trading day, not UTC. (`en-CA` formats as YYYY-MM-DD.)
//
import { prisma } from "../../../prisma";

const BASE = 1000; // first number of the day
const SPAN = 9000; // 1000..9999 inclusive

/**
 * Returns today's Lagos date as "YYYY-MM-DD" — the bucket key for the counter.
 */
function lagosDateKey(now: Date = new Date()): string {
  // en-CA gives an ISO-like YYYY-MM-DD; timeZone pins it to the trading day.
  return now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
}

/**
 * Atomically reserve the next daily order number for a branch.
 *
 * The upsert is the whole concurrency story: the DB performs the `increment`,
 * so two simultaneous dine-in orders on the same branch get distinct counters.
 * We then fold the counter into the 1000–9999 display range (wrapping after
 * 9000 orders/day — effectively never hit, but safe).
 *
 * @returns a 4-digit integer in [1000, 9999]
 */
export async function nextDailyOrderNumber(branchId: string): Promise<number> {
  const date = lagosDateKey();

  const row = await prisma.dailyOrderCounter.upsert({
    where: { branchId_date: { branchId, date } }, // @@unique([branchId, date])
    create: { branchId, date, counter: 1 },
    update: { counter: { increment: 1 } },
  });

  // counter is 1-based; map 1 -> 1000, 2 -> 1001, ... wrapping within the span.
  return BASE + ((row.counter - 1) % SPAN);
}