// =============================================================================
// src/modules/social/services/feedRanking.service.ts
// -----------------------------------------------------------------------------
// PHASE 11 — FEED RANKING · THE ENGINE ("build one For-You page")
// =============================================================================
//
// READ THIS FIRST — THE MENTAL MODEL
// ----------------------------------
// Every modern feed (TikTok, Instagram, etc.) is built in FOUR stages. Memorise
// these four words and the whole file becomes obvious:
//
//   1. CANDIDATE GENERATION  — cheaply gather a few hundred posts this user
//      MIGHT like, from a handful of bounded sources. We never score the whole
//      database; we only score a small, smart shortlist.
//
//   2. FILTERING             — throw out posts we must not show: ones the user
//      already saw (dedup), their own posts, duplicates across sources.
//
//   3. RANKING               — give every surviving candidate a personal score
//      and sort. This is where "for YOU" happens.
//
//   4. RE-RANKING (policy)   — adjust the pure-score order for product reasons:
//      diversity (don't show 5 posts from one author in a row) and exploration
//      (deliberately inject some "outside your bubble" posts — your TikTok
//      intuition, done safely).
//
// Then we take the top `limit`, mark them as served (dedup memory), and return.
//
// WHY CANDIDATE GENERATION INSTEAD OF "score every post"?
// -------------------------------------------------------
// If you have 1,000,000 posts you CANNOT score them all on every feed pull —
// that is a full-table scan and it will bankrupt you and time out. Instead we
// pull a few BOUNDED, INDEXED slices ("give me the 60 freshest posts in the
// hashtags this user loves", etc.), union them into a pool of ~a few hundred,
// and score only that pool in memory. This is THE trick that makes feeds cheap.
// You said "no full-table scans" — this is how we keep that promise.
//
// YOUR TIKTOK THEORY, IMPLEMENTED HONESTLY
// ----------------------------------------
// You said TikTok injects "irrelevant" content so the user keeps scrolling
// hunting for the good stuff. The real, safe version of that is TWO mechanisms
// working together, both in stage 4:
//   - EXPLORATION: a fixed fraction of every page (EXPLORE_RATIO) is reserved
//     for fresh / new-creator / outside-your-affinity posts. This both creates
//     the "variable reward" hunt feeling AND lets unknown creators get
//     discovered (critical for a young app — without it, only already-popular
//     people ever surface and nobody new can grow).
//   - DIVERSITY: we forbid the same author clustering, so the page feels varied.
// We do NOT inject genuinely irrelevant junk — that causes churn. We inject
// FRESH and UNPROVEN, which feels like discovery, not noise.
//
// EXHAUSTION FALLBACK
// -------------------
// A heavy user can run out of unseen posts. We never return an empty feed:
// when unseen candidates run low we top up with the user's STALEST-seen posts
// (things they haven't seen in ~2 weeks) so the feed feels endless. See
// feedSeen.getStalestSeenPostIds.
// =============================================================================

import { Post } from "@prisma/client";
import { prisma } from "../../../prisma";
import {
  getSeenPostIds,
  getStalestSeenPostIds,
  recordSeen,
} from "./feedSeen.service";
import { getAffinityProfile, AffinityProfile } from "./affinity.service";

// -----------------------------------------------------------------------------
// TUNABLES — every knob that shapes the feed lives here, with plain-English notes
// -----------------------------------------------------------------------------

/** How many posts each candidate SOURCE pulls. Small numbers keep every query
 *  fast; the union of sources is what gives breadth. */
const PULL = {
  FOLLOWED: 60, // recent posts from people you follow
  AFFINITY_TAG: 60, // recent posts in your favourite hashtags
  AFFINITY_AUTHOR: 40, // recent posts by creators you engage with
  TRENDING: 60, // globally hot posts (time-windowed)
  EXPLORE: 50, // fresh / unproven posts for discovery
} as const;

/** Only consider posts from the last N days as "fresh" candidates. Older posts
 *  can still appear via the trending/affinity pulls if their score is high, but
 *  the fresh/explore pulls stay recent so the feed feels current. */
const FRESH_WINDOW_DAYS = 21;

/** Fraction of each page reserved for exploration (discovery). 0.18 = roughly 1
 *  in 5 posts is something outside your proven taste. This is the dial for your
 *  "irrelevant in between" loop — turn it DOWN if the feed feels random, UP if
 *  it feels like a bubble. */
const EXPLORE_RATIO = 0.18;

/** Diversity guard: an author may not appear again within this many slots. */
const AUTHOR_COOLDOWN = 3;

/** Time-decay shape (Hacker-News style "gravity"). Higher = older posts die
 *  faster. This is the fix for the old bug where timeDecay was hard-coded to 1
 *  (i.e. no decay at all). We apply decay at READ time so freshness is always
 *  current without recomputing stored scores. */
const GRAVITY = 1.4;

/** The score blend. Each term's contribution = weight × (a 0..1 signal). Tuning
 *  these is how you change the feed's "personality" without touching logic. */
const W = {
  ENGAGEMENT: 1.0, // global quality (decayed likes/comments/views)
  AFFINITY_AUTHOR: 2.2, // you engage with this creator
  AFFINITY_TAG: 1.6, // post matches hashtags you like
  FOLLOWING: 1.2, // you follow the author
  BOOST: 1.5, // creator paid to boost (existing Phase-10 feature)
  FRESHNESS: 0.6, // brand-new gets a small leg up (cold-start help)
  EXPLORE_NOISE: 0.8, // controlled randomness → unpredictable "hunt" feeling
} as const;

// A candidate is a Post plus bookkeeping about WHERE it came from and its score.
type CandidateSource =
  | "followed"
  | "affinity_tag"
  | "affinity_author"
  | "trending"
  | "explore"
  | "exhaustion";

interface Candidate {
  post: Post;
  source: CandidateSource;
  score: number;
  isExplore: boolean; // true if it should count toward the exploration quota
}

// =============================================================================
// PUBLIC ENTRY POINT
// =============================================================================
//
// Build one For-You page for `userId` (null = guest). Returns the ordered posts
// and whether more exist. The controller shapes these for the client.
// =============================================================================
export async function buildForYouFeed(opts: {
  userId: string | null;
  limit: number;
}): Promise<{ posts: Post[]; hasMore: boolean }> {
  const { userId } = opts;
  const limit = Math.min(Math.max(opts.limit, 1), 50);

  // --- STAGE 0: load the user's context in parallel (seen set + taste) -------
  // Both are fail-open: guests / missing tables → empty, and the feed degrades
  // to "trending + fresh" rather than breaking.
  const [seen, affinity] = await Promise.all([
    getSeenPostIds(userId),
    getAffinityProfile(userId),
  ]);

  // Followed author ids (for the follow-graph candidate source + the FOLLOWING
  // score term). Guests follow nobody.
  const followedIds = await getFollowedIds(userId);
  const followedSet = new Set(followedIds);

  // --- STAGE 1: CANDIDATE GENERATION (bounded, indexed, parallel) ------------
  const pools = await Promise.all([
    pullFollowed(followedIds),
    pullAffinityTags(affinity.topHashtags),
    pullAffinityAuthors(affinity.topAuthors),
    pullTrending(),
    pullExplore(),
  ]);

  // --- STAGE 2: FILTER + DEDUP across sources --------------------------------
  // Merge all pools into a single map keyed by postId (so a post that showed up
  // in two sources is kept once). While merging we drop:
  //   - the user's own posts (never show yourself in For-You)
  //   - already-seen posts (dedup)
  const byId = new Map<string, Candidate>();
  for (const { rows, source } of pools) {
    for (const post of rows) {
      if (userId && post.userId === userId) continue; // skip self
      if (seen.has(post.id)) continue; // dedup
      if (byId.has(post.id)) {
        // Already in pool from a higher-priority source; keep the stronger
        // source tag so exploration accounting stays sensible.
        continue;
      }
      byId.set(post.id, {
        post,
        source,
        score: 0,
        isExplore: source === "explore",
      });
    }
  }

  let candidates = Array.from(byId.values());

  // --- STAGE 2b: BACKFILL when the pool is thin -------------------------------
  // This is the answer to "what happens at the very start when there are only a
  // handful of posts, or later when posting volume is low?". Two tiers:
  //
  //   (i) ALL-TIME UNSEEN: the main candidate pulls only look back FRESH_WINDOW_
  //       DAYS, so a brand-new app (few posts) is fine, but a post OLDER than the
  //       window that a user simply hasn't reached yet would be invisible. Here
  //       we pull the newest posts IGNORING the window, and add any that are
  //       unseen, not ours, and not already pooled. This guarantees a user can
  //       see every post that exists before anything repeats.
  //
  //  (ii) STALEST-SEEN RE-SHOW: only if there is genuinely nothing unseen left
  //       (a heavy user on a low-volume app), re-show what they saw longest ago
  //       so the feed is never empty. With only 3–10 posts total this is normal
  //       and expected — there simply isn't new content, so we cycle the oldest-
  //       seen rather than show a blank feed.
  if (candidates.length < limit) {
    // (i) all-time unseen backfill — newest first, no fresh-window gate.
    const backfill = await prisma.post.findMany({
      where: userId ? { userId: { not: userId } } : {},
      orderBy: { createdAt: "desc" },
      take: limit * 3, // small over-fetch; we filter in memory below
    });
    for (const post of backfill) {
      if (byId.has(post.id)) continue;
      if (seen.has(post.id)) continue;
      byId.set(post.id, {
        post,
        source: "explore",
        score: 0,
        isExplore: false, // backfill isn't "discovery", it's just availability
      });
    }
    candidates = Array.from(byId.values());
  }

  // (ii) stalest-seen re-show — last resort so the feed never ends.
  if (candidates.length < limit && userId) {
    const need = limit * 2 - candidates.length;
    const staleIds = await getStalestSeenPostIds(userId, need);
    const fresh = staleIds.filter((id) => !byId.has(id));
    if (fresh.length > 0) {
      const staleRows = await prisma.post.findMany({
        where: { id: { in: fresh }, userId: userId ? { not: userId } : undefined },
      });
      for (const post of staleRows) {
        byId.set(post.id, {
          post,
          source: "exhaustion",
          score: 0,
          isExplore: false,
        });
      }
      candidates = Array.from(byId.values());
    }
  }

  if (candidates.length === 0) {
    return { posts: [], hasMore: false };
  }

  // --- STAGE 3: RANKING (score every candidate, personal to this user) -------
  const now = Date.now();
  for (const c of candidates) {
    c.score = scoreCandidate(c, {
      now,
      affinity,
      followedSet,
    });
  }
  // Pure quality order, best first.
  candidates.sort((a, b) => b.score - a.score);

  // --- STAGE 4: RE-RANK for diversity + exploration quota ---------------------
  const page = assemblePage(candidates, limit);

  // --- STAGE 5: remember what we served (dedup memory for next pull) ----------
  // We AWAIT this (it's a single small batched write). Awaiting matters for
  // pagination correctness: the client's "load more" calls again WITHOUT a
  // cursor, relying on the server to exclude what it just served. If this write
  // hadn't committed yet, page 2 could overlap page 1. The write is tiny (~20
  // rows), so awaiting costs a few ms and removes the race.
  const servedIds = page.map((c) => c.post.id);
  await recordSeen(userId, servedIds);

  // hasMore: were there candidates we didn't use this page? If yes, the next
  // pull (which will exclude everything we just marked seen) will have content.
  const hasMore = candidates.length > page.length;

  return { posts: page.map((c) => c.post), hasMore };
}

// =============================================================================
// STAGE 1 HELPERS — each candidate source is one bounded, indexed query
// =============================================================================

/** Common WHERE fragment: only posts from the fresh window, optionally excluding
 *  reposts to avoid flooding the pool with duplicates of the same content.
 *  (Reposts still reach the feed via the original; tune if you want them in.) */
function freshWhere() {
  const since = new Date(
    Date.now() - FRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  return { createdAt: { gte: since } };
}

async function pullFollowed(followedIds: string[]) {
  if (followedIds.length === 0)
    return { rows: [] as Post[], source: "followed" as const };
  const rows = await prisma.post.findMany({
    where: { userId: { in: followedIds }, ...freshWhere() },
    orderBy: { createdAt: "desc" }, // uses @@index([userId, createdAt])
    take: PULL.FOLLOWED,
  });
  return { rows, source: "followed" as const };
}

async function pullAffinityTags(tags: string[]) {
  if (tags.length === 0)
    return { rows: [] as Post[], source: "affinity_tag" as const };
  // `hasSome` → posts whose hashtags array overlaps the user's favourite tags.
  // Postgres array overlap; bounded by take + fresh window.
  const rows = await prisma.post.findMany({
    where: { hashtags: { hasSome: tags }, ...freshWhere() },
    orderBy: { algorithmScore: "desc" }, // best-in-tag first
    take: PULL.AFFINITY_TAG,
  });
  return { rows, source: "affinity_tag" as const };
}

async function pullAffinityAuthors(authorIds: string[]) {
  if (authorIds.length === 0)
    return { rows: [] as Post[], source: "affinity_author" as const };
  const rows = await prisma.post.findMany({
    where: { userId: { in: authorIds }, ...freshWhere() },
    orderBy: { createdAt: "desc" },
    take: PULL.AFFINITY_AUTHOR,
  });
  return { rows, source: "affinity_author" as const };
}

async function pullTrending() {
  // Globally hot, time-windowed so we don't resurface ancient viral posts.
  // Uses @@index([algorithmScore, createdAt]).
  const rows = await prisma.post.findMany({
    where: { ...freshWhere() },
    orderBy: { algorithmScore: "desc" },
    take: PULL.TRENDING,
  });
  return { rows, source: "trending" as const };
}

async function pullExplore() {
  // Discovery pool: the very freshest posts regardless of popularity. This is
  // where brand-new creators get their first shot (cold start) and where the
  // "outside your bubble" content comes from. Uses @@index([createdAt]).
  const rows = await prisma.post.findMany({
    where: { ...freshWhere() },
    orderBy: { createdAt: "desc" },
    take: PULL.EXPLORE,
  });
  return { rows, source: "explore" as const };
}

/** Who does this user follow? Reads the Follow graph (guests → []). */
async function getFollowedIds(userId: string | null): Promise<string[]> {
  if (!userId) return [];
  try {
    const rows = await prisma.follow.findMany({
      where: { followerId: userId },
      select: { followingId: true },
    });
    return rows.map((r) => r.followingId);
  } catch {
    return [];
  }
}

// =============================================================================
// STAGE 3 — THE SCORING FUNCTION (pure, testable, explainable)
// =============================================================================
//
// Given one candidate and the user context, return a single number. Higher =
// show sooner. Every term is documented; the WEIGHTS are in `W` above. Because
// this is a pure function of (post, context), you can unit-test it and you can
// eyeball exactly why any post ranked where it did. Explainability was a
// requirement — this is it.
// =============================================================================
function scoreCandidate(
  c: Candidate,
  ctx: { now: number; affinity: AffinityProfile; followedSet: Set<string> },
): number {
  const p = c.post;
  const { now, affinity, followedSet } = ctx;

  // --- TERM 1: time-decayed global engagement (quality) ----------------------
  // p.algorithmScore is the slow-moving popularity number maintained elsewhere
  // (likes/comments/views). We compress it with log10 (so a 10,000-view post is
  // not 1000× a 10-view post — diminishing returns), then multiply by time
  // decay so fresh quality beats stale quality.
  const ageHours = Math.max(0, (now - p.createdAt.getTime()) / 3_600_000);
  const timeDecay = 1 / Math.pow(ageHours + 2, GRAVITY); // (+2 softens hour 0)
  const engagement =
    Math.log10((p.algorithmScore ?? 0) + 1) * timeDecay;

  // --- TERM 2: author affinity (do YOU engage with this creator?) ------------
  // Normalised to 0..1 by the user's strongest signal so it's comparable.
  const authorAff =
    (affinity.authorWeight.get(p.userId) ?? 0) / affinity.maxWeight;

  // --- TERM 3: hashtag affinity (does this post match tags YOU like?) --------
  // Sum the user's weight for each of the post's hashtags, normalised. A post
  // hitting several of your favourite tags scores higher than one hitting just
  // one.
  let tagAff = 0;
  for (const tag of p.hashtags) {
    tagAff += affinity.hashtagWeight.get(tag.toLowerCase()) ?? 0;
  }
  tagAff = Math.min(1, tagAff / affinity.maxWeight); // cap at 1

  // --- TERM 4: follow graph (you explicitly chose this creator) --------------
  const followBonus = followedSet.has(p.userId) ? 1 : 0;

  // --- TERM 5: paid boost (existing Phase-10 monetisation) -------------------
  const boostActive =
    p.isBoosted &&
    (!p.boostExpiresAt || p.boostExpiresAt.getTime() > now)
      ? 1
      : 0;

  // --- TERM 6: freshness (cold-start help for brand-new posts) ---------------
  // A small bonus that fades over the first ~12 hours, so a great post by an
  // unknown creator isn't instantly buried by older popular ones.
  const freshness = Math.max(0, 1 - ageHours / 12);

  // --- TERM 7: exploration noise (the "hunt" / variable-reward dial) ---------
  // A small RANDOM term, applied only to exploration candidates. This is what
  // makes the order unpredictable — the user can't tell which scroll delivers
  // the next hit, which is exactly the loop you described. Kept small so it
  // perturbs ordering without overriding genuine relevance.
  const exploreNoise = c.isExplore ? Math.random() : 0;

  return (
    W.ENGAGEMENT * engagement +
    W.AFFINITY_AUTHOR * authorAff +
    W.AFFINITY_TAG * tagAff +
    W.FOLLOWING * followBonus +
    W.BOOST * boostActive +
    W.FRESHNESS * freshness +
    W.EXPLORE_NOISE * exploreNoise
  );
}

// =============================================================================
// STAGE 4 — ASSEMBLE THE PAGE (diversity + exploration quota)
// =============================================================================
//
// Input: candidates already sorted by score (best first).
// Output: up to `limit` candidates, re-ordered so that:
//   (a) no author appears within AUTHOR_COOLDOWN slots of themselves, and
//   (b) at least EXPLORE_RATIO of the page is exploration content (if available).
//
// HOW IT WORKS (greedy with a cooldown queue):
//   We walk the sorted list and place each candidate IF its author hasn't
//   appeared too recently; otherwise we hold it aside and retry it later. We
//   also track how many exploration items we've placed and, near the end, if we
//   are short of the quota, we prefer held exploration items.
// =============================================================================
function assemblePage(sorted: Candidate[], limit: number): Candidate[] {
  const page: Candidate[] = [];
  const recentAuthors: string[] = []; // last AUTHOR_COOLDOWN authors placed
  const deferred: Candidate[] = []; // held back by the author cooldown

  const exploreQuota = Math.floor(limit * EXPLORE_RATIO);
  let explorePlaced = 0;

  const canPlace = (c: Candidate) =>
    !recentAuthors.includes(c.post.userId);

  const place = (c: Candidate) => {
    page.push(c);
    if (c.isExplore) explorePlaced++;
    recentAuthors.push(c.post.userId);
    if (recentAuthors.length > AUTHOR_COOLDOWN) recentAuthors.shift();
  };

  // First pass: greedily place in score order, honouring the author cooldown.
  for (const c of sorted) {
    if (page.length >= limit) break;
    if (canPlace(c)) place(c);
    else deferred.push(c); // try again once the author cools down
  }

  // Second pass: fill remaining slots from the deferred queue (author cooldown
  // naturally satisfied now that other authors are interleaved).
  for (const c of deferred) {
    if (page.length >= limit) break;
    if (canPlace(c)) place(c);
  }

  // Exploration top-up: if we under-filled the discovery quota AND there are
  // still exploration candidates we skipped, swap some in. This guarantees the
  // page always has a discovery flavour even when proven content dominated the
  // score order. (Simple version: append remaining explore candidates if there
  // is still room after the cooldown passes.)
  if (explorePlaced < exploreQuota && page.length < limit) {
    for (const c of sorted) {
      if (page.length >= limit) break;
      if (!c.isExplore) continue;
      if (page.includes(c)) continue;
      if (canPlace(c)) place(c);
    }
  }

  return page;
}