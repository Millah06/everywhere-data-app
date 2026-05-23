// ─────────────────────────────────────────────────────────────────────────────
// search.controller.ts  — HTTP layer, validation, response shaping
// ─────────────────────────────────────────────────────────────────────────────
import * as service from '../services/search.service';
import { SearchRequest, SuggestionsRequest, TrendingRequest, FollowersRequest } 
from '../types/search.types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok  = (res: any, data: unknown) => res.status(200).json({ success: true,  ...data as object });
const err = (res: any, status: number, message: string) =>
  res.status(status).json({ success: false, message });

function parsePagination(query: Record<string, any>) {
  const limit  = Math.min(parseInt(query.limit  ?? '20', 10), 50);
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;
  return { limit, cursor };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /search?q=&tab=&cursor=&limit=
// ─────────────────────────────────────────────────────────────────────────────

const search = async (req: any, res: any) => {
  try {
    const { q, tab = 'top' } = req.query as Record<string, string>;

    if (!q || q.trim().length === 0) return err(res, 400, 'Query param `q` is required');
    if (q.trim().length > 100)       return err(res, 400, 'Query too long (max 100 chars)');

    if (!['top', 'users', 'posts', 'hashtags'].includes(tab))
      return err(res, 400, 'Invalid tab. Must be top | users | posts | hashtags');

    const { limit, cursor } = parsePagination(req.query);
    const requesterId = req.user.id;

    const searchReq: SearchRequest = { q, tab: tab as any, limit, cursor, requesterId };

    let result;
    switch (tab) {
      case 'users':    result = await service.searchUsers(searchReq);    break;
      case 'posts':    result = await service.searchPosts(searchReq);    break;
      case 'hashtags': result = await service.searchHashtags(searchReq); break;
      default:         result = await service.searchTop(searchReq);      break;
    }

    // Optionally save search query to history (fire-and-forget)
    if (requesterId && q.trim().length > 0) {
      service.saveSearchHistory(requesterId, { kind: 'query', label: q.trim() }).catch(() => {});
    }

    return ok(res, result);
  } catch (e: any) {
    console.error('[search]', e);
    return err(res, 500, e.message ?? 'Internal server error');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /search/suggestions?q=&limit=
// ─────────────────────────────────────────────────────────────────────────────

const suggestions = async (req: any, res: any) => {
  try {
    const { q, limit } = req.query as Record<string, string>;
    if (!q) return err(res, 400, '`q` is required');

    const result = await service.getSearchSuggestions({
      q,
      requesterId: req.user.id,
      limit:       limit ? parseInt(limit, 10) : 6,
    });

    return ok(res, result);
  } catch (e: any) {
    console.error('[search/suggestions]', e);
    return err(res, 500, e.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /search/trending?limit=&windowHours=
// ─────────────────────────────────────────────────────────────────────────────

const trending = async (req: any, res: any) => {
  try {
    const { limit, windowHours } = req.query as Record<string, string>;
    const result = await service.getTrending({
      limit:       limit       ? parseInt(limit, 10)       : 10,
      windowHours: windowHours ? parseInt(windowHours, 10) : 24,
    });
    return ok(res, result);
  } catch (e: any) {
    console.error('[search/trending]', e);
    return err(res, 500, e.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Search History  (requires auth)
// ─────────────────────────────────────────────────────────────────────────────

const getHistory = async (req: any, res: any) => {
  try {
    const userId = req.user.id;
    if (!userId) return err(res, 401, 'Unauthenticated');
    // Actually delegate to repo
    const { getSearchHistory } = await import('../repository/search.repository');
    const items = await getSearchHistory(userId, 20);
    return ok(res, { data: items });
  } catch (e: any) {
    return err(res, 500, e.message);
  }
};

const deleteHistoryItem = async (req: any, res: any) => {
  try {
    const userId = req.user.id;
    if (!userId) return err(res, 401, 'Unauthenticated');
    const { id } = req.params;
    await service.deleteSearchHistoryItem(userId, id);
    return ok(res, { message: 'Deleted' });
  } catch (e: any) {
    return err(res, 500, e.message);
  }
};

const clearHistory = async (req: any, res: any) => {
  try {
    const userId = req.user.id;
    if (!userId) return err(res, 401, 'Unauthenticated');
    await service.clearSearchHistory(userId);
    return ok(res, { message: 'History cleared' });
  } catch (e: any) {
    return err(res, 500, e.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /users/:userId/followers?cursor=&limit=&q=
// GET /users/:userId/following?cursor=&limit=&q=
// ─────────────────────────────────────────────────────────────────────────────

export const getFollowers = async (req: any, res: any) => {
  try {
    const { userId } = req.params;
    const { limit, cursor } = parsePagination(req.query);
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;

    const result = await service.getFollowersList({
      userId,
      requesterId: req.user.id,
      type: 'followers',
      q,
      limit,
      cursor,
    });

    return ok(res, result);
  } catch (e: any) {
    console.error('[followers]', e);
    return err(res, 500, e.message);
  }
};

export const getFollowing = async (req: any, res: any) => {
  try {
    const { userId } = req.params;
    const { limit, cursor } = parsePagination(req.query);
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;

    const result = await service.getFollowersList({
      userId,
      requesterId: req.user.id,
      type: 'following',
      q,
      limit,
      cursor,
    });

    return ok(res, result);
  } catch (e: any) {
    console.error('[following]', e);
    return err(res, 500, e.message);
  }
};

export default {
  search,
  suggestions,
  trending,
  getHistory,
  deleteHistoryItem,
  clearHistory,
  getFollowers,
  getFollowing,
};