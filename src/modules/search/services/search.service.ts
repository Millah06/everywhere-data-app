// ─────────────────────────────────────────────────────────────────────────────
// search.service.ts  — Ranking, scoring, intent parsing, business logic
// ─────────────────────────────────────────────────────────────────────────────

import {
  ParsedQuery,
  SearchIntent,
  SearchRequest,
  SearchResponse,
  UserResult,
  PostResult,
  HashtagResult,
  TopResult,
  Suggestion,
  SuggestionsResponse,
  TrendingResponse,
  TrendingRequest,
  SuggestionsRequest,
  FollowersRequest,
  PageMeta,
  RANK,
  encodeCursor,
  decodeCursor,
  CursorPayload,
} from './search.types';

import * as repo from './search.repository';

// ─────────────────────────────────────────────────────────────────────────────
// Query parsing
// ─────────────────────────────────────────────────────────────────────────────

export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();

  let intent: SearchIntent = 'mixed';
  let clean = trimmed;

  if (trimmed.startsWith('@')) {
    intent = 'user';
    clean = trimmed.slice(1);
  } else if (trimmed.startsWith('#')) {
    intent = 'hashtag';
    clean = trimmed.slice(1);
  } else if (trimmed.length > 0) {
    // Heuristic: if it looks like "normal words" → mixed
    intent = 'mixed';
  }

  // Tokenise for multi-term matching (e.g. "john travel blog")
  const terms = clean
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 0);

  return { raw: trimmed, clean: clean.toLowerCase(), intent, terms };
}

// ─────────────────────────────────────────────────────────────────────────────
// User ranking
// ─────────────────────────────────────────────────────────────────────────────

function scoreUser(
  profile: any,
  clean: string,
  requesterId?: string,
): number {
  const handle = (profile.userName ?? '').toLowerCase();
  const name   = (profile.user?.name ?? '').toLowerCase();
  const q      = clean.toLowerCase();

  let score = 0;

  // Match quality
  if (handle === q)             score += RANK.USER_EXACT_HANDLE;
  else if (handle.startsWith(q)) score += RANK.USER_STARTS_HANDLE;
  else if (handle.includes(q))   score += RANK.USER_CONTAINS;

  if (name === q)              score += RANK.USER_EXACT_NAME;
  else if (name.startsWith(q)) score += RANK.USER_STARTS_NAME;

  // Boosts
  if (profile.isVerified)      score += RANK.BOOST_VERIFIED;

  // Following relationship boost
  const isFollowing = requesterId
    ? (profile.user?.followers ?? []).some((f: any) => f.followerId === requesterId)
    : false;
  if (isFollowing) score += RANK.BOOST_FOLLOWING;

  // Mutual: user follows requester back
  const isMutual = requesterId
    ? (profile.user?.following ?? []).some((f: any) => f.followingId === requesterId)
    : false;
  if (isMutual) score += RANK.BOOST_MUTUAL;

  // Popularity log boost
  score += RANK.BOOST_FOLLOWERS_LOG * Math.log10((profile.followersCount ?? 0) + 1);

  return score;
}

function mapUser(profile: any, score: number, requesterId?: string): UserResult {
  const isFollowing = requesterId
    ? (profile.user?.followers ?? []).some((f: any) => f.followerId === requesterId)
    : false;
  const isMutual = requesterId
    ? (profile.user?.following ?? []).some((f: any) => f.followingId === requesterId)
    : false;

  return {
    userId:              profile.userId,
    userName:            profile.user?.name ?? '',
    userHandle:          profile.userName ?? '',
    avatarUrl:           profile.avatarUrl || undefined,
    bio:                 profile.bio || undefined,
    isVerified:          profile.isVerified,
    topBadge:            profile.badges ? JSON.stringify(profile.badges) : undefined,
    followersCount:      profile.followersCount,
    isFollowing,
    isMutual,
    mutualFollowersCount: 0,  // filled in later if requested
    _score:              score,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post ranking
// ─────────────────────────────────────────────────────────────────────────────

function scorePost(post: any, clean: string, terms: string[]): number {
  const title = (post.title ?? '').toLowerCase();
  const text  = (post.text  ?? '').toLowerCase();
  const tags  = (post.hashtags ?? []).map((h: string) => h.toLowerCase());

  let score = 0;

  for (const term of terms) {
    if (title === term)             score += RANK.POST_EXACT_TITLE;
    else if (title.startsWith(term)) score += RANK.POST_STARTS_TITLE;
    else if (title.includes(term))   score += RANK.POST_CONTAINS_TITLE;
    if (text.includes(term))         score += RANK.POST_CONTAINS_TEXT;
    if (tags.includes(term))         score += RANK.POST_HASHTAG_MATCH;
  }

  // Popularity boosts
  score += RANK.BOOST_POST_VIEWS * Math.log10((post.viewCount ?? 0) + 1);
  score += RANK.BOOST_POST_LIKES * Math.log10((post.likeCount ?? 0) + 1);
  score += RANK.BOOST_POST_COINS * Math.log10((post.coinTotal ?? 0) + 1);
  if (post.isBoosted) score += RANK.BOOST_POST_BOOSTED;

  return score;
}

function mapPost(post: any, score: number, requesterId?: string): PostResult {
  const isLiked = requesterId
    ? (post.likes ?? []).some((l: any) => l.userId === requesterId)
    : false;
  const isFollowing = requesterId
    ? (post.user?.followers ?? []).some((f: any) => f.followerId === requesterId)
    : false;

  const boostActive = post.isBoosted &&
    (!post.boostExpiresAt || new Date(post.boostExpiresAt) > new Date());

  return {
    postId:                 post.id,
    userId:                 post.userId,
    userName:               post.userName,
    userHandle:             post.userHandle ?? '',
    userAvatar:             post.userAvatar ?? undefined,
    topBadge:               post.topBadge ?? undefined,
    title:                  post.title ?? undefined,
    text:                   post.text,
    images:                 post.images,
    hashtags:               post.hashtags,
    likeCount:              post.likeCount,
    commentCount:           post.commentCount,
    viewCount:              post.viewCount,
    coinTotal:              post.coinTotal,
    giftCount:              post.giftCount,
    repostCount:            0,  // add relation if needed
    isLikedByCurrentUser:   isLiked,
    isFollowing,
    isBoostActive:          boostActive,
    isRepost:               post.isRepost,
    originalPostId:         post.originalPostId ?? undefined,
    originalUserName:       post.originalUserName ?? undefined,
    originalUserHandle:     post.originalUserHandle ?? undefined,
    createdAt:              post.createdAt,
    _score:                 score,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashtag ranking
// ─────────────────────────────────────────────────────────────────────────────

function scoreHashtag(tag: string, clean: string, recentCount: bigint): number {
  const q = clean.replace('#', '').toLowerCase();
  const t = tag.toLowerCase();

  let score = 0;
  if (t === q)              score += RANK.HASHTAG_EXACT;
  else if (t.startsWith(q)) score += RANK.HASHTAG_STARTS;
  else if (t.includes(q))   score += RANK.HASHTAG_CONTAINS;

  score += RANK.BOOST_HASHTAG_TREND * Math.log10(Number(recentCount) + 1);
  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor-based pagination helper
// ─────────────────────────────────────────────────────────────────────────────

function paginateResults<T extends { _score: number; [key: string]: any }>(
  items: T[],
  idField: string,
  limit: number,
): { page: T[]; meta: PageMeta } {
  const sorted = [...items].sort((a, b) => b._score - a._score);
  const hasMore = sorted.length > limit;
  const page = hasMore ? sorted.slice(0, limit) : sorted;

  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ id: last[idField], score: last._score })
    : null;

  return { page, meta: { hasMore, nextCursor } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public service methods
// ─────────────────────────────────────────────────────────────────────────────

export async function searchUsers(
  req: SearchRequest,
): Promise<SearchResponse<UserResult[]>> {
  const parsed = parseQuery(req.q);
  const cursor = req.cursor ? decodeCursor(req.cursor) : null;
  const limit  = Math.min(req.limit ?? 20, 50);

  const raw = await repo.queryUsers({
    clean: parsed.clean,
    requesterId: req.requesterId,
    cursor,
    limit,
  });

  const scored = raw.map(p => mapUser(p, scoreUser(p, parsed.clean, req.requesterId), req.requesterId));
  const { page, meta } = paginateResults(scored, 'userId', limit);

  return { data: page, meta, query: req.q, tab: 'users' };
}

export async function searchPosts(
  req: SearchRequest,
): Promise<SearchResponse<PostResult[]>> {
  const parsed = parseQuery(req.q);
  const cursor = req.cursor ? decodeCursor(req.cursor) : null;
  const limit  = Math.min(req.limit ?? 20, 50);

  const raw = await repo.queryPosts({
    clean: parsed.clean,
    terms: parsed.terms,
    requesterId: req.requesterId,
    cursor,
    limit,
  });

  const scored = raw.map(p => mapPost(p, scorePost(p, parsed.clean, parsed.terms), req.requesterId));
  const { page, meta } = paginateResults(scored, 'postId', limit);

  return { data: page, meta, query: req.q, tab: 'posts' };
}

export async function searchHashtags(
  req: SearchRequest,
): Promise<SearchResponse<HashtagResult[]>> {
  const parsed = parseQuery(req.q);
  const limit  = Math.min(req.limit ?? 20, 50);

  const rows = await repo.queryHashtags({ clean: parsed.clean, limit });
  const hasMore = rows.length > limit;

  const results: HashtagResult[] = rows.slice(0, limit).map(row => {
    const trendScore = scoreHashtag(row.tag, parsed.clean, row.recent_count);
    return {
      tag:        row.tag,
      postCount:  Number(row.post_count),
      isTrending: Number(row.recent_count) > 10,
      trendScore,
    };
  });

  const last = results[results.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ id: last.tag, score: last.trendScore })
    : null;

  return {
    data: results,
    meta: { hasMore, nextCursor },
    query: req.q,
    tab: 'hashtags',
  };
}

export async function searchTop(
  req: SearchRequest,
): Promise<SearchResponse<TopResult>> {
  const parsed = parseQuery(req.q);
  const limit  = Math.min(req.limit ?? 20, 50);

  // Intent-aware routing: bias the batch sizes
  let userLimit = 3, postLimit = 6, hashLimit = 3;
  if (parsed.intent === 'user')    { userLimit = 10; postLimit = 3; hashLimit = 1; }
  if (parsed.intent === 'hashtag') { hashLimit = 8;  postLimit = 5; userLimit = 1; }

  const [usersRaw, postsRaw, hashRows] = await Promise.all([
    repo.queryUsers({ clean: parsed.clean, requesterId: req.requesterId, limit: userLimit }),
    repo.queryPosts({ clean: parsed.clean, terms: parsed.terms, requesterId: req.requesterId, limit: postLimit }),
    repo.queryHashtags({ clean: parsed.clean, limit: hashLimit }),
  ]);

  const users = usersRaw
    .map(p => mapUser(p, scoreUser(p, parsed.clean, req.requesterId), req.requesterId))
    .sort((a, b) => b._score - a._score)
    .slice(0, userLimit);

  const posts = postsRaw
    .map(p => mapPost(p, scorePost(p, parsed.clean, parsed.terms), req.requesterId))
    .sort((a, b) => b._score - a._score)
    .slice(0, postLimit);

  const hashtags: HashtagResult[] = hashRows.map(row => ({
    tag:        row.tag,
    postCount:  Number(row.post_count),
    isTrending: Number(row.recent_count) > 10,
    trendScore: scoreHashtag(row.tag, parsed.clean, row.recent_count),
  }));

  return {
    data: { users, posts, hashtags },
    meta: { hasMore: false, nextCursor: null },
    query: req.q,
    tab: 'top',
  };
}

export async function getSearchSuggestions(
  req: SuggestionsRequest,
): Promise<SuggestionsResponse> {
  const parsed = parseQuery(req.q);
  const limit  = req.limit ?? 6;

  const suggestions: Suggestion[] = [];

  if (parsed.intent === 'user' || parsed.intent === 'mixed') {
    const users = await repo.queryUsers({ clean: parsed.clean, requesterId: req.requesterId, limit: 3 });
    for (const u of users.slice(0, 3)) {
      suggestions.push({
        kind:       'user',
        label:      u.userName ?? '',
        subLabel:   `${u.followersCount.toLocaleString()} followers`,
        avatarUrl:  u.avatarUrl ?? undefined,
        userId:     u.userId,
        isVerified: u.isVerified,
      });
    }
  }

  if (parsed.intent === 'hashtag' || parsed.intent === 'mixed') {
    const tags = await repo.queryHashtags({ clean: parsed.clean, limit: 3 });
    for (const t of tags.slice(0, 3)) {
      suggestions.push({
        kind:     'hashtag',
        label:    `#${t.tag}`,
        subLabel: `${Number(t.post_count).toLocaleString()} posts`,
      });
    }
  }

  // Always add a raw query suggestion as fallback
  if (parsed.clean.length > 1) {
    suggestions.push({ kind: 'query', label: parsed.raw });
  }

  const recentSearches = req.requesterId
    ? await repo.getSearchHistory(req.requesterId, 8)
    : [];

  return { suggestions: suggestions.slice(0, limit), recentSearches };
}

export async function getTrending(req: TrendingRequest): Promise<TrendingResponse> {
  const windowHours = req.windowHours ?? 24;
  const limit       = req.limit ?? 10;

  const [hashRows, suggestedUsers] = await Promise.all([
    repo.getTrendingHashtags(windowHours, limit),
    repo.getSuggestedUsers(undefined, 8),
  ]);

  const hashtags: HashtagResult[] = hashRows.map(row => ({
    tag:        row.tag,
    postCount:  Number(row.post_count),
    isTrending: true,
    trendScore: Number(row.recent_count),
  }));

  const users: UserResult[] = suggestedUsers.map(p => mapUser(p, 0, undefined));

  return { hashtags, suggestedUsers: users };
}

export async function getFollowersList(req: FollowersRequest & { type: 'followers' | 'following' }) {
  const cursor = req.cursor ? decodeCursor(req.cursor) : null;
  const limit  = Math.min(req.limit ?? 20, 50);

  const rows = await repo.queryFollowList({
    userId:      req.userId,
    requesterId: req.requesterId,
    type:        req.type,
    q:           req.q,
    cursor,
    limit,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const users: UserResult[] = page.map(row => {
    const profile = req.type === 'followers'
      ? (row as any).follower
      : (row as any).following;

    const up = profile.userProfile;
    const isFollowing = req.requesterId
      ? (profile.followers ?? []).some((f: any) => f.followerId === req.requesterId)
      : false;

    return {
      userId:              profile.id,
      userName:            profile.name,
      userHandle:          up?.userName ?? '',
      avatarUrl:           up?.avatarUrl || undefined,
      bio:                 up?.bio || undefined,
      isVerified:          up?.isVerified ?? false,
      followersCount:      up?.followersCount ?? 0,
      isFollowing,
      isMutual:            false,
      mutualFollowersCount: 0,
      _score:              0,
    };
  });

  const last = page[page.length - 1] as any;
  const lastUser = req.type === 'followers' ? last?.follower : last?.following;
  const nextCursor = hasMore && lastUser
    ? encodeCursor({ id: lastUser.id, score: 0 })
    : null;

  return { data: users, meta: { hasMore, nextCursor } };
}

// Save search to history (called after user taps a result or presses enter)
export async function saveSearchHistory(
  userId: string,
  data: Parameters<typeof repo.upsertSearchHistory>[1],
) {
  return repo.upsertSearchHistory(userId, data);
}

export async function deleteSearchHistoryItem(userId: string, id: string) {
  return repo.deleteSearchHistoryItem(userId, id);
}

export async function clearSearchHistory(userId: string) {
  return repo.clearSearchHistory(userId);
}