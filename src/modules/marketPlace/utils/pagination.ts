// ─────────────────────────────────────────────────────────────────────────────
// Cursor pagination helpers (Phase 8)
//
// We use Prisma's native keyset cursor (`cursor: { id }, skip: 1`) anchored on a
// stable compound order `[{ <sortField>: "desc" }, { id: "asc" }]`. Because the
// id is unique and always the final tiebreak, Prisma can resolve the exact page
// boundary from the id alone — so the encoded cursor only carries the id.
//
// The cursor is an opaque base64url token so the client never depends on its
// internal shape; we can change what's inside later without an app release.
// ─────────────────────────────────────────────────────────────────────────────

export interface CursorPayload {
  id: string;
}

/** Encode a row id into an opaque base64url cursor token. */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** Decode a cursor token. Returns null for missing/garbage tokens (→ first page). */
export function decodeCursor(raw?: unknown): CursorPayload | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed && typeof parsed.id === "string") return { id: parsed.id };
    return null;
  } catch {
    return null;
  }
}

/** Clamp a client-supplied page size to a sane, capped integer. */
export function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = parseInt(String(raw ?? fallback), 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/**
 * Build the `{ data, meta }` envelope from a `take + 1` over-fetch.
 * Over-fetching one row is how we know whether a next page exists without a
 * second COUNT query (cheap).
 */
export function buildPage<T extends { id: string }>(
  rows: T[],
  limit: number,
): { data: T[]; meta: { nextCursor: string | null; hasMore: boolean } } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && data.length > 0 ? encodeCursor({ id: data[data.length - 1].id }) : null;
  return { data, meta: { nextCursor, hasMore } };
}

/**
 * Order status buckets that back the customer/vendor order tabs. The tabs are
 * status *groups*, so each tab paginates its own group server-side (one cursor
 * per bucket on the client). Keep these in sync with the Flutter OrderStatus
 * groupings (ongoing/completed/cancelled/appealed).
 */
export const ORDER_BUCKETS: Record<string, string[]> = {
  ongoing: [
    "pending",
    "confirmed",
    "preparing",
    "outForDelivery",
    "delivered",
    "pendingFundRelease",
  ],
  completed: ["completed"],
  cancelled: ["cancelled"],
  appealed: ["appealed"],
};