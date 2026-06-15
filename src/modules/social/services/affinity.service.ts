// =============================================================================
// src/modules/social/services/affinity.service.ts
// -----------------------------------------------------------------------------
// PHASE 11 — FEED RANKING · USER INTEREST MODEL ("what does THIS user want?")
// =============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// The old "For You" feed showed EVERY user the same global popularity order.
// That is "what's hot," not "for you." To make it personal we need a cheap,
// explainable answer to one question: for a given user, which TOPICS and which
// AUTHORS do they actually engage with?
//
// We answer it WITHOUT machine learning. We just keep a running tally per user:
//   - per hashtag they engage with  → a weight
//   - per author they engage with    → a weight
// The more (and the more strongly) they engage, the higher the weight. That
// tally IS the user's taste profile. This is exactly how the earliest versions
// of every "for you" feed worked, and it is more than enough at your scale.
//
// THE SIGNAL LADDER (engagement is not binary)
// --------------------------------------------
// Not all engagement means the same thing. A gift is a far stronger "I love
// this" than a passive view. So each event nudges the weight by a different
// amount (see EVENT_WEIGHTS). This is the cheap stand-in for TikTok's
// "watch-time / completion rate" — until we add real dwell-time later (Pass 3
// hooks are already designed for it), these explicit actions are our signal.
//
//   view     → +1   (weak: they let the card sit, maybe)
//   like     → +3   (clear positive)
//   comment  → +5   (high effort = high interest)
//   gift     → +8   (spent coins = strongest signal we have)
//
// DECAY (taste changes; old interests must fade)
// ----------------------------------------------
// If we only ever ADDED weight, a topic you loved a year ago would dominate
// forever. So the nightly job multiplies every weight by DECAY_FACTOR (0.9).
// A topic you stop engaging with loses ~10% of its pull each day and quietly
// drops out of your profile. Topics you keep feeding stay strong. This is the
// "recency of taste" mechanism, and it is one line of math.
//
// COST CONTROL (bills)
// --------------------
// - Composite PK (userId, kind, topic) → upsert, never duplicate rows.
// - The nightly decay job also DELETES any weight that has decayed below
//   AFFINITY_FLOOR, so dead interests are physically removed. The table self-
//   prunes; it cannot grow without bound for an inactive interest.
// - Reads pull only the TOP-N affinities (indexed by weight), never the whole
//   profile.
//
// FAIL-OPEN
// ---------
// Writes here are bookkeeping. If the table is missing or a write fails, the
// feed must still work — it just becomes less personal. Every function below
// swallows its own errors. Callers fire-and-forget (never await on the request
// hot path) so personalization NEVER slows a response. "Feel fast" was your
// rule; this is how we keep it.
// =============================================================================

import { prisma } from "../../../prisma";

// -----------------------------------------------------------------------------
// TUNABLES
// -----------------------------------------------------------------------------

/** How strongly each engagement type nudges affinity weights. Tune freely. */
export const EVENT_WEIGHTS = {
  view: 1,
  like: 3,
  comment: 5,
  gift: 8,
} as const;
export type EngagementEvent = keyof typeof EVENT_WEIGHTS;

/** Nightly multiplier applied to every weight (see decayAffinities). 0.9 = lose
 *  ~10% per day of any interest you stop feeding. */
export const DECAY_FACTOR = 0.9;

/** Below this weight an affinity is considered dead and deleted by the nightly
 *  job (keeps the table small). */
export const AFFINITY_FLOOR = 0.5;

/** How many of the user's strongest hashtag/author affinities the ranker pulls
 *  to build a taste profile. We do not need the long tail to rank one page. */
const TOP_HASHTAGS = 12;
const TOP_AUTHORS = 12;

// Mirrors the Prisma enum `AffinityKind { hashtag author }`.
type AffinityKind = "hashtag" | "author";

// -----------------------------------------------------------------------------
// WRITE — the single hook the rest of the app calls
// -----------------------------------------------------------------------------
//
// This is the ONLY function the controllers need to call. Given "user X did
// engagement E on post P", it:
//   1. loads P's hashtags + author (one tiny indexed read),
//   2. bumps the user's affinity for the author and for each hashtag by the
//      event weight.
//
// We deliberately accept (userId, postId, event) — the two ids are ALWAYS in
// scope wherever engagement happens (like/comment/gift/view controllers), so
// the hook is a trivial one-liner at each call site and we never have to thread
// the post object through. The extra read is cheap and fire-and-forget.
//
// A user never builds affinity toward THEIR OWN content (it would pollute their
// feed with themselves), so we skip self-engagement.
// -----------------------------------------------------------------------------
export async function bumpAffinityForEngagement(
  userId: string | null,
  postId: string,
  event: EngagementEvent,
): Promise<void> {
  if (!userId) return;

  try {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { userId: true, hashtags: true },
    });
    if (!post) return;
    if (post.userId === userId) return; // don't learn taste from your own posts

    const delta = EVENT_WEIGHTS[event];

    // Build the list of (kind, topic) pairs to bump:
    //   - exactly one AUTHOR pair (the post's creator)
    //   - one HASHTAG pair per tag, lower-cased so "#Lagos" and "#lagos" merge
    const ops: Array<{ kind: AffinityKind; topic: string }> = [
      { kind: "author", topic: post.userId },
      ...post.hashtags
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0)
        .map((topic) => ({ kind: "hashtag" as AffinityKind, topic })),
    ];

    // Upsert each pair: create at `delta` if new, otherwise increment by `delta`.
    // We run them in parallel; each is keyed on the composite PK so there is no
    // contention. We do NOT wrap in a transaction — affinity is best-effort, and
    // a partial update is harmless (it self-corrects on the next engagement).
    await Promise.all(
      ops.map((op) =>
        prisma.userTopicAffinity.upsert({
          where: {
            userId_kind_topic: { userId, kind: op.kind, topic: op.topic },
          },
          create: { userId, kind: op.kind, topic: op.topic, weight: delta },
          update: { weight: { increment: delta } },
        }),
      ),
    );
  } catch (err) {
    // Bookkeeping only — never break the engagement action that triggered us.
    console.warn(
      "[affinity] bumpAffinityForEngagement fell open:",
      (err as Error).message,
    );
  }
}

// -----------------------------------------------------------------------------
// READ — the user's taste profile, shaped for the ranker
// -----------------------------------------------------------------------------
//
// Returns the user's strongest hashtags and authors, plus a `maxWeight` used to
// NORMALISE scores into 0..1 so affinity is comparable across users (a whale who
// engages constantly and a newcomer both end up on the same 0..1 scale).
//
// `hashtagWeight` / `authorWeight` are lookup maps the ranker uses to score each
// candidate post by how well it matches this user's taste.
// -----------------------------------------------------------------------------
export interface AffinityProfile {
  hashtagWeight: Map<string, number>; // lower-cased hashtag → weight
  authorWeight: Map<string, number>; // authorUserId → weight
  topHashtags: string[]; // for candidate generation (which tags to pull)
  topAuthors: string[]; // for candidate generation (which authors to pull)
  maxWeight: number; // for normalisation (>= 1 to avoid div-by-zero)
}

export async function getAffinityProfile(
  userId: string | null,
): Promise<AffinityProfile> {
  const empty: AffinityProfile = {
    hashtagWeight: new Map(),
    authorWeight: new Map(),
    topHashtags: [],
    topAuthors: [],
    maxWeight: 1,
  };
  if (!userId) return empty;

  try {
    // Two tight queries, each using @@index([userId, weight]) to grab the top
    // slice ordered by weight desc. No full-profile scan.
    const [hashtags, authors] = await Promise.all([
      prisma.userTopicAffinity.findMany({
        where: { userId, kind: "hashtag" },
        orderBy: { weight: "desc" },
        take: TOP_HASHTAGS,
        select: { topic: true, weight: true },
      }),
      prisma.userTopicAffinity.findMany({
        where: { userId, kind: "author" },
        orderBy: { weight: "desc" },
        take: TOP_AUTHORS,
        select: { topic: true, weight: true },
      }),
    ]);

    const hashtagWeight = new Map(hashtags.map((h) => [h.topic, h.weight]));
    const authorWeight = new Map(authors.map((a) => [a.topic, a.weight]));

    // maxWeight = the single strongest signal this user has. Used to normalise.
    const maxWeight = Math.max(
      1,
      ...hashtags.map((h) => h.weight),
      ...authors.map((a) => a.weight),
    );

    return {
      hashtagWeight,
      authorWeight,
      topHashtags: hashtags.map((h) => h.topic),
      topAuthors: authors.map((a) => a.topic),
      maxWeight,
    };
  } catch (err) {
    console.warn(
      "[affinity] getAffinityProfile fell open:",
      (err as Error).message,
    );
    return empty;
  }
}

// -----------------------------------------------------------------------------
// MAINTENANCE — nightly decay + cleanup (called by the cron)
// -----------------------------------------------------------------------------
//
// 1. Multiply every weight by DECAY_FACTOR (taste fades).
// 2. Delete anything that has fallen below AFFINITY_FLOOR (dead interest → gone,
//    keeps the table small → keeps the bill small).
//
// We do the multiply with a single raw SQL UPDATE because Prisma cannot express
// "set column = column * constant" through its typed API. The DELETE is plain
// Prisma. Both are bounded, indexed operations.
//
// Returns { decayed, deleted } counts for logging.
// -----------------------------------------------------------------------------
export async function decayAffinities(): Promise<{
  decayed: number;
  deleted: number;
}> {
  try {
    // $executeRaw is parameterised → safe. Table name is quoted to match
    // Prisma's default PascalCase table naming.
    const decayed = await prisma.$executeRaw`
      UPDATE "UserTopicAffinity"
      SET weight = weight * ${DECAY_FACTOR}
    `;

    const { count: deleted } = await prisma.userTopicAffinity.deleteMany({
      where: { weight: { lt: AFFINITY_FLOOR } },
    });

    return { decayed: Number(decayed), deleted };
  } catch (err) {
    console.warn(
      "[affinity] decayAffinities fell open:",
      (err as Error).message,
    );
    return { decayed: 0, deleted: 0 };
  }
}