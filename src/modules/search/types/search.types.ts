// ─────────────────────────────────────────────────────────────────────────────
// search.types.ts  — Contracts for the entire search system
// ─────────────────────────────────────────────────────────────────────────────

// ── Query parsing ─────────────────────────────────────────────────────────────

export type SearchIntent = 'user' | 'hashtag' | 'text' | 'mixed';

export interface ParsedQuery {
  raw: string;           // original input
  clean: string;         // stripped of @/#
  intent: SearchIntent;  // inferred intent
  terms: string[];       // tokenized search terms
}

// ── Pagination ────────────────────────────────────────────────────────────────

export interface CursorPage {
  cursor?: string;   // opaque base64 cursor (encodes { id, score })
  limit: number;     // items per page, default 20, max 50
}

export interface PageMeta {
  hasMore: boolean;
  nextCursor: string | null;
  total?: number;    // only included when cheap to compute
}

// ── Search request DTOs ───────────────────────────────────────────────────────

export interface SearchRequest extends CursorPage {
  q: string;
  tab: 'top' | 'users' | 'posts' | 'hashtags';
  requesterId?: string;  // nullable — guest users can search too
}

export interface TrendingRequest {
  limit?: number;      // default 10
  windowHours?: number; // scoring window, default 24
}

export interface SuggestionsRequest {
  q: string;
  requesterId?: string;
  limit?: number;      // default 6
}

export interface FollowersRequest extends CursorPage {
  userId: string;
  requesterId?: string;
  q?: string;          // search within followers/following
}

// ── Result item types ─────────────────────────────────────────────────────────

export interface UserResult {
  userId: string;
  userName: string;
  userHandle: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  isVerified: boolean;
  topBadge?: string;
  followersCount: number;
  isFollowing: boolean;      // relative to requester
  isMutual: boolean;         // requester follows back
  mutualFollowersCount: number;
  _score: number;            // internal ranking, stripped before response
}

export interface PostResult {
  postId: string;
  userId: string;
  userName: string;
  userHandle: string;
  userAvatar?: string;
  topBadge?: string;
  title?: string;
  text: string;
  images: string[];
  hashtags: string[];
  likeCount: number;
  commentCount: number;
  viewCount: number;
  coinTotal: number;
  giftCount: number;
  repostCount: number;
  isLikedByCurrentUser: boolean;
  isFollowing: boolean;
  isBoostActive: boolean;
  isRepost: boolean;
  originalPostId?: string;
  originalUserName?: string;
  originalUserHandle?: string;
  createdAt: Date;
  _score: number;
}

export interface HashtagResult {
  tag: string;            // without #
  postCount: number;
  isTrending: boolean;
  trendScore: number;     // used for ordering
  recentPosts?: PostResult[]; // optional preview, first 3
}

export interface TopResult {
  users: UserResult[];
  posts: PostResult[];
  hashtags: HashtagResult[];
}

// ── Suggestion types ──────────────────────────────────────────────────────────

export type SuggestionKind = 'user' | 'hashtag' | 'query';

export interface Suggestion {
  kind: SuggestionKind;
  label: string;           // display text
  subLabel?: string;       // e.g. follower count, post count
  avatarUrl?: string;      // for user suggestions
  userId?: string;         // for user suggestions
  isVerified?: boolean;
}

// ── Search history ────────────────────────────────────────────────────────────

export interface SearchHistoryItem {
  id: string;
  kind: SuggestionKind;
  label: string;
  subLabel?: string | null;
  avatarUrl?: string | null;
  userId?: string;
  searchedAt: Date;
}

// ── Response wrappers ─────────────────────────────────────────────────────────

export interface SearchResponse<T> {
  data: T;
  meta: PageMeta;
  query: string;
  tab: string;
}

export interface SuggestionsResponse {
  suggestions: Suggestion[];
  recentSearches: SearchHistoryItem[];
}

export interface TrendingResponse {
  hashtags: HashtagResult[];
  suggestedUsers: UserResult[];
}

// ── Ranking weights (centralised so easy to tune) ─────────────────────────────

export const RANK = {
  // User ranking
  USER_EXACT_HANDLE:   100,
  USER_STARTS_HANDLE:   80,
  USER_EXACT_NAME:      70,
  USER_STARTS_NAME:     60,
  USER_CONTAINS:        40,
  BOOST_VERIFIED:       20,
  BOOST_FOLLOWING:      15,
  BOOST_MUTUAL:         10,
  BOOST_FOLLOWERS_LOG:   5,  // multiplied by Math.log10(followersCount + 1)

  // Post ranking
  POST_EXACT_TITLE:     80,
  POST_STARTS_TITLE:    60,
  POST_CONTAINS_TITLE:  40,
  POST_CONTAINS_TEXT:   25,
  POST_HASHTAG_MATCH:   35,
  BOOST_POST_VIEWS:      3,  // multiplied by Math.log10(viewCount + 1)
  BOOST_POST_LIKES:      4,  // multiplied by Math.log10(likeCount + 1)
  BOOST_POST_BOOSTED:   20,
  BOOST_POST_COINS:      5,  // multiplied by Math.log10(coinTotal + 1)

  // Hashtag ranking
  HASHTAG_EXACT:       100,
  HASHTAG_STARTS:       70,
  HASHTAG_CONTAINS:     40,
  BOOST_HASHTAG_COUNT:   5,  // multiplied by Math.log10(postCount + 1)
  BOOST_HASHTAG_TREND:  30,
} as const;

// ── Cursor encoding ───────────────────────────────────────────────────────────

export interface CursorPayload {
  id: string;
  score: number;
  createdAt?: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}