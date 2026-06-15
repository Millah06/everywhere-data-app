// =============================================================================
// src/modules/social/services/feedSeen.service.ts
// -----------------------------------------------------------------------------
// PHASE 11 — FEED RANKING · "SEEN" TRACKING (the dedup brain)
// =============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// You asked the key question: "are they (TikTok) tracking seen content and
// trying not to bring them again?" — yes, and so do we, right here.
//
// A feed that repeats posts feels dead. The single most important thing that
// makes an infinite feed feel "alive" is: NEVER show the same post twice in a
// reasonable window. To do that we must remember, PER USER, which posts we have
// already PUT IN FRONT OF THEM.
//
// THE TWO DIFFERENT "SEEN" CONCEPTS (this is the core lesson)
// ----------------------------------------------------------
// There are two completely different ideas people lazily both call "seen":
//
//   1. SERVED  — "the server placed this post in a feed page for this user."
//                This happens BEFORE the user's eyes ever touch it. It is what
//                we use for DEDUP, because we must decide "show or not show"
//                while building the page, not after.
//
//   2. VIEWED  — "the post's card actually rendered on screen and the user
//                looked at it." This is an ENGAGEMENT signal (it feeds the
//                interest model in affinity.service.ts). The repo already
//                tracks this in `PostViewTracker` via viewController.ts.
//
// We keep them in SEPARATE tables on purpose:
//   - FeedSeen          → "SERVED" → used here, only for dedup.
//   - PostViewTracker   → "VIEWED" → used for the interest model + view counts.
//
// Mixing them into one table would pollute the engagement signal with posts the
// user never actually looked at (they scrolled past instantly). Two small,
// single-purpose tables are clearer and each one is trivially prunable.
//
// COST CONTROL (you hate bills — this is built for that)
// ------------------------------------------------------
// FeedSeen grows by ~1 row per post served per user. That is the biggest table
// in this feature. We control it three ways:
//   - Composite primary key (userId, postId) → re-serving the same post is an
//     UPSERT, never a duplicate row. The table can only ever hold one row per
//     (user, post) pair.
//   - We only look back FEED_SEEN_RETENTION_DAYS when excluding (so the
//     "exclude" query stays small and indexed).
//   - The nightly job (feedMaintenance.ts) DELETES rows older than the
//     retention window, so the table physically shrinks every night.
// Start tight (14 days). When the app is earning, raise the constant.
//
// MIGRATION-SAFE / FAIL-OPEN
// --------------------------
// Every function is wrapped so that if the FeedSeen table does not exist yet
// (you deploy code before running the migration), the feed still works — it
// just behaves as if nothing has been seen. This mirrors the "migration-safe
// no-op" pattern already used by your cron jobs. A feed must NEVER 500 because
// a bookkeeping table is missing.
// =============================================================================

import { prisma } from "../../../prisma";

// -----------------------------------------------------------------------------
// TUNABLES (kept here so you change behaviour without touching logic)
// -----------------------------------------------------------------------------

/** How far back we look when excluding already-served posts. Also the prune
 *  horizon used by the nightly job. 14 days = a post can re-appear at most once
 *  every two weeks if it is still relevant. Bump this when bills are not a
 *  worry. */
export const FEED_SEEN_RETENTION_DAYS = 14;

/** Hard cap on how many "seen" ids we pull into memory for the exclude filter.
 *  A heavy scroller could have tens of thousands of rows; we never need them
 *  all to build one page. We pull the most recent N — anything older than that
 *  is, by definition, old enough to be safe to re-surface anyway. */
const SEEN_FETCH_CAP = 4000;

// -----------------------------------------------------------------------------
// READ — which posts has this user already been served? (the exclude set)
// -----------------------------------------------------------------------------
//
// Returns a Set<string> of postIds. We use a Set (not an array) because the
// ranking service checks membership thousands of times while filtering the
// candidate pool, and Set.has() is O(1) while array.includes() is O(n).
//
// Guests (userId === null) have no server-side history → empty set. (On web a
// guest's dedup is handled client-side instead; not our concern here.)
// -----------------------------------------------------------------------------
export async function getSeenPostIds(
  userId: string | null,
): Promise<Set<string>> {
  if (!userId) return new Set();

  const since = new Date(
    Date.now() - FEED_SEEN_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  try {
    // Index used: @@index([userId, seenAt]) — this query is a tight range scan,
    // never a full-table scan.
    const rows = await prisma.feedSeen.findMany({
      where: { userId, seenAt: { gte: since } },
      select: { postId: true },
      orderBy: { seenAt: "desc" },
      take: SEEN_FETCH_CAP,
    });
    return new Set(rows.map((r) => r.postId));
  } catch (err) {
    // Table missing or transient DB error → behave as "nothing seen".
    console.warn("[feedSeen] getSeenPostIds fell open:", (err as Error).message);
    return new Set();
  }
}

// -----------------------------------------------------------------------------
// READ — least-recently-seen posts (the "graceful exhaustion" fallback)
// -----------------------------------------------------------------------------
//
// THE PROBLEM: a power user can eventually exhaust all unseen posts. A naive
// dedup feed would then return EMPTY — the worst possible experience. TikTok
// never shows you an empty feed; when you have seen everything fresh, it
// re-surfaces older things you haven't seen in a while.
//
// THE FIX: when the ranker runs short of unseen candidates, it asks for the
// posts this user saw LONGEST AGO (oldest seenAt first) and is allowed to
// re-show them. "You saw this 13 days ago" feels like new content again.
//
// Returns postIds ordered oldest-seen-first.
// -----------------------------------------------------------------------------
export async function getStalestSeenPostIds(
  userId: string | null,
  take: number,
): Promise<string[]> {
  if (!userId || take <= 0) return [];
  try {
    const rows = await prisma.feedSeen.findMany({
      where: { userId },
      select: { postId: true },
      orderBy: { seenAt: "asc" }, // oldest first = "haven't seen in the longest"
      take,
    });
    return rows.map((r) => r.postId);
  } catch (err) {
    console.warn(
      "[feedSeen] getStalestSeenPostIds fell open:",
      (err as Error).message,
    );
    return [];
  }
}

// -----------------------------------------------------------------------------
// WRITE — mark a batch of posts as served to this user
// -----------------------------------------------------------------------------
//
// Called by the ranking service at the END of building a page, with exactly the
// postIds it is about to return. One batched write per page (~20 rows), not one
// write per post — that keeps it cheap.
//
// `skipDuplicates: true` + the (userId, postId) primary key means re-serving a
// post (e.g. during graceful exhaustion) does NOT update seenAt. If you WANT a
// re-served post to push its seenAt forward (so it goes back to the bottom of
// the staleness queue), switch to the upsert loop noted below. For now skip is
// cheaper and the behaviour is fine.
//
// This is fire-and-forget from the caller's perspective: we never want a feed
// response to fail or slow down because bookkeeping hiccuped. The caller may
// `void recordSeen(...)` without awaiting, OR await it (it's fast). It always
// resolves, never throws.
// -----------------------------------------------------------------------------
export async function recordSeen(
  userId: string | null,
  postIds: string[],
): Promise<void> {
  if (!userId || postIds.length === 0) return;

  // De-dup the incoming ids defensively (a candidate pool should already be
  // unique, but never trust the caller for a write).
  const unique = Array.from(new Set(postIds));

  try {
    await prisma.feedSeen.createMany({
      data: unique.map((postId) => ({ userId, postId })),
      skipDuplicates: true, // (userId, postId) already present → ignore
    });
  } catch (err) {
    // Never propagate — bookkeeping must not break the feed.
    console.warn("[feedSeen] recordSeen fell open:", (err as Error).message);
  }
}

// -----------------------------------------------------------------------------
// MAINTENANCE — delete rows past the retention horizon (called by the cron)
// -----------------------------------------------------------------------------
//
// This is what keeps the table (and your bill) bounded. Runs nightly. Returns
// the number of rows deleted so the job can log it.
// -----------------------------------------------------------------------------
export async function pruneFeedSeen(
  retentionDays: number = FEED_SEEN_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  try {
    const { count } = await prisma.feedSeen.deleteMany({
      where: { seenAt: { lt: cutoff } },
    });
    return count;
  } catch (err) {
    console.warn("[feedSeen] pruneFeedSeen fell open:", (err as Error).message);
    return 0;
  }
}