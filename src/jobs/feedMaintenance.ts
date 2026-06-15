// =============================================================================
// src/jobs/feedMaintenance.ts
// -----------------------------------------------------------------------------
// PHASE 11 — FEED RANKING · NIGHTLY MAINTENANCE
// =============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// The feed-ranking feature creates three append-heavy tables. Left alone they
// grow forever and your hosting bill grows with them. This single nightly job
// keeps all of them bounded:
//
//   1. FeedSeen          — DELETE rows older than the retention window.
//                          (dedup memory; we only need ~2 weeks of it.)
//
//   2. PostViewTracker   — DELETE old rows. THIS TABLE ALREADY EXISTED in your
//                          repo and was NEVER pruned, so it has been growing
//                          unbounded since day one. Pruning it here actively
//                          REDUCES your current bill. We keep 30 days: long
//                          enough that the 24h view-dedup logic in
//                          viewController.ts is unaffected, short enough to stay
//                          cheap. After 30 days a re-view can re-count a view —
//                          harmless.
//
//   3. UserTopicAffinity — DECAY every weight (taste fades) and DELETE dead
//                          interests. Keeps the taste table small and current.
//
// SAFETY
// ------
// The whole job is fail-CLOSED at the boundary (one big try/catch so a thrown
// error can never crash the Node process / scheduler), but each step is itself
// fail-OPEN inside its service (a missing table is a no-op). So you can deploy
// this BEFORE running the Phase-11 migration and it simply logs zeros until the
// tables exist — exactly like your reconciliation / trust jobs.
//
// SCHEDULING
// ----------
// Registered in src/jobs/index.ts. We run it nightly at 03:30, right after the
// 03:00 reconciliation snapshot, so all the heavy nightly DB work is batched
// into the quiet hours.
// =============================================================================

import {
  pruneFeedSeen,
  FEED_SEEN_RETENTION_DAYS,
} from "../modules/social/services/feedSeen.service";
import { decayAffinities } from "../modules/social/services/affinity.service";
import { prisma } from "../prisma";

/** How long to keep per-user view rows. See note above. */
const VIEW_TRACKER_RETENTION_DAYS = 30;

export async function runFeedMaintenanceJob(): Promise<void> {
  const startedAt = Date.now();
  try {
    // 1) FeedSeen prune --------------------------------------------------------
    const seenDeleted = await pruneFeedSeen(FEED_SEEN_RETENTION_DAYS);

    // 2) PostViewTracker prune (reduces the pre-existing unbounded table) ------
    let viewsDeleted = 0;
    try {
      const cutoff = new Date(
        Date.now() - VIEW_TRACKER_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      const res = await prisma.postViewTracker.deleteMany({
        where: { lastViewedAt: { lt: cutoff } },
      });
      viewsDeleted = res.count;
    } catch (err) {
      // Table should exist (it predates Phase 11), but stay fail-open anyway.
      console.warn(
        "[feedMaintenance] view-tracker prune fell open:",
        (err as Error).message,
      );
    }

    // 3) Affinity decay + cleanup ---------------------------------------------
    const { decayed, deleted: affinityDeleted } = await decayAffinities();

    console.log(
      `[feedMaintenance] done in ${Date.now() - startedAt}ms — ` +
        `feedSeen -${seenDeleted}, viewTracker -${viewsDeleted}, ` +
        `affinity decayed ${decayed} / -${affinityDeleted}`,
    );
  } catch (err) {
    // Fail-closed: never let a maintenance error escape and kill the scheduler.
    console.error("[feedMaintenance] job failed:", (err as Error).message);
  }
}