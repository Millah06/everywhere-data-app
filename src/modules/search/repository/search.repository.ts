// ─────────────────────────────────────────────────────────────────────────────
// search.repository.ts  — All raw Prisma queries, zero business logic here
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from '@prisma/client';
import { prisma } from '../../../prisma';
import { CursorPayload, decodeCursor, RANK } from '../types/search.types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Safe log-boost that never goes negative */
const logBoost = (n: number) => Math.log10(Math.max(n, 0) + 1);

/** Build a case-insensitive ilike filter for Prisma */
const ilike = (field: string, value: string): Prisma.StringFilter => ({
  contains: value,
  mode: 'insensitive',
});

// ─────────────────────────────────────────────────────────────────────────────
// User queries
// ─────────────────────────────────────────────────────────────────────────────

interface UserQueryParams {
  clean: string;
  requesterId?: string;
  cursor?: CursorPayload | null;
  limit: number;
}

export async function queryUsers({ clean, requesterId, cursor, limit }: UserQueryParams) {
  // Fetch a larger batch so we can re-rank in memory then slice
  const batchSize = Math.min(limit * 3, 100);

  const users = await prisma.userProfile.findMany({
    where: {
      OR: [
        { userName: ilike('userName', clean) },
        { user: { name: ilike('name', clean) } },
      ],
      // Exclude soft-deleted accounts
      user: { deletedAt: null, active: true },
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          // check if requester follows this user
          followers: requesterId
            ? { where: { followerId: requesterId }, select: { followerId: true } }
            : false,
          // check if this user follows requester (for mutual detection)
          following: requesterId
            ? { where: { followingId: requesterId }, select: { followingId: true } }
            : false,
        },
      },
    },
    take: batchSize,
    // Cursor: skip records after the cursor position
    ...(cursor ? { skip: 1, cursor: { userId: cursor.id } } : {}),
  });

  return users;
}

export async function getMutualFollowersCount(
  userId: string,
  requesterId: string,
): Promise<number> {
  // Count users who follow BOTH userId and requesterId
  const result = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*) as count
    FROM "Follow" f1
    INNER JOIN "Follow" f2 ON f1."followerId" = f2."followerId"
    WHERE f1."followingId" = ${userId}
      AND f2."followingId" = ${requesterId}
  `;
  return Number(result[0].count);
}

// ─────────────────────────────────────────────────────────────────────────────
// Post queries
// ─────────────────────────────────────────────────────────────────────────────

interface PostQueryParams {
  clean: string;
  terms: string[];
  requesterId?: string;
  cursor?: CursorPayload | null;
  limit: number;
}

export async function queryPosts({ clean, terms, requesterId, cursor, limit }: PostQueryParams) {
  const batchSize = Math.min(limit * 3, 100);

  // Build OR conditions for all terms
  const termConditions = terms.flatMap(term => [
    { title: ilike('title', term) },
    { text: ilike('text', term) },
    { hashtags: { has: term.replace('#', '') } },
  ]);

  const posts = await prisma.post.findMany({
    where: {
      AND: [
        { user: { deletedAt: null, active: true } },
        { OR: termConditions.length > 0 ? termConditions : [{ text: ilike('text', clean) }] },
      ],
    },
    include: {
      // check if requester liked this post
      likes: requesterId
        ? { where: { userId: requesterId }, select: { userId: true } }
        : false,
      // check if requester follows post author
      user: {
        select: {
          followers: requesterId
            ? { where: { followerId: requesterId }, select: { followerId: true } }
            : false,
        },
      },
    },
    orderBy: [
      { isBoosted: 'desc' },
      { algorithmScore: 'desc' },
      { createdAt: 'desc' },
    ],
    take: batchSize,
    ...(cursor
      ? {
          skip: 1,
          cursor: { id: cursor.id },
        }
      : {}),
  });

  return posts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashtag queries — posts table is the source of truth
// ─────────────────────────────────────────────────────────────────────────────

interface HashtagQueryParams {
  clean: string;
  cursor?: CursorPayload | null;
  limit: number;
}

export async function queryHashtags({ clean, cursor, limit }: HashtagQueryParams) {
  // Aggregate hashtag usage counts directly from the posts table.
  // We use raw SQL for the unnest + group-by pattern which Prisma doesn't support natively.
  const tag = clean.replace('#', '').toLowerCase();

  const rows = await prisma.$queryRaw<
    Array<{ tag: string; post_count: bigint; recent_count: bigint }>
  >`
    SELECT
      lower(unnested_tag) AS tag,
      COUNT(*)            AS post_count,
      COUNT(*) FILTER (WHERE p."createdAt" > NOW() - INTERVAL '48 hours') AS recent_count
    FROM "Post" p,
         UNNEST(p.hashtags) AS unnested_tag
    WHERE lower(unnested_tag) LIKE ${`%${tag}%`}
    GROUP BY lower(unnested_tag)
    ORDER BY
      CASE WHEN lower(unnested_tag) = ${tag} THEN 0 ELSE 1 END,
      recent_count DESC,
      post_count DESC
    LIMIT ${limit + 1}
  `;

  return rows;
}

export async function getTrendingHashtags(windowHours: number, limit: number) {
  const rows = await prisma.$queryRaw<
    Array<{ tag: string; post_count: bigint; recent_count: bigint }>
  >`
    SELECT
      lower(unnested_tag) AS tag,
      COUNT(*)            AS post_count,
      COUNT(*) FILTER (WHERE p."createdAt" > NOW() - INTERVAL '${windowHours} hours') AS recent_count
    FROM "Post" p,
         UNNEST(p.hashtags) AS unnested_tag
    GROUP BY lower(unnested_tag)
    HAVING COUNT(*) FILTER (WHERE p."createdAt" > NOW() - INTERVAL '${windowHours} hours') > 0
    ORDER BY recent_count DESC, post_count DESC
    LIMIT ${limit}
  `;
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search history
// ─────────────────────────────────────────────────────────────────────────────

export async function getSearchHistory(userId: string, limit = 15) {
  return prisma.searchHistory.findMany({
    where: { userId },
    orderBy: { searchedAt: 'desc' },
    take: limit,
  });
}

export async function upsertSearchHistory(
  userId: string,
  data: {
    kind: 'user' | 'hashtag' | 'query';
    label: string;
    subLabel?: string;
    avatarUrl?: string;
    refUserId?: string;
  },
) {
  // Upsert by label so duplicate searches just bump the timestamp
  return prisma.searchHistory.upsert({
    where: { userId_label: { userId, label: data.label } },
    create: { userId, ...data, searchedAt: new Date() },
    update: { searchedAt: new Date() },
  });
}

export async function deleteSearchHistoryItem(userId: string, id: string) {
  return prisma.searchHistory.deleteMany({ where: { id, userId } });
}

export async function clearSearchHistory(userId: string) {
  return prisma.searchHistory.deleteMany({ where: { userId } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Followers / Following
// ─────────────────────────────────────────────────────────────────────────────

interface FollowListParams {
  userId: string;
  requesterId?: string;
  type: 'followers' | 'following';
  q?: string;
  cursor?: CursorPayload | null;
  limit: number;
}

export async function queryFollowList({
  userId,
  requesterId,
  type,
  q,
  cursor,
  limit,
}: FollowListParams) {
  const searchFilter = q
    ? {
        OR: [
          { userName: ilike('userName', q) },
          { user: { name: ilike('name', q) } },
        ],
      }
    : {};

  if (type === 'followers') {
    // People who follow userId
    const rows = await prisma.follow.findMany({
      where: {
        followingId: userId,
        follower: {
          userProfile: { ...searchFilter },
          deletedAt: null,
          active: true,
        },
      },
      include: {
        follower: {
          include: {
            userProfile: true,
            // does requesterId follow this person?
            followers: requesterId
              ? { where: { followerId: requesterId }, select: { followerId: true } }
              : false,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { followerId_followingId: { followerId: cursor.id, followingId: userId } } } : {}),
    });
    return rows;
  } else {
    // People userId follows
    const rows = await prisma.follow.findMany({
      where: {
        followerId: userId,
        following: {
          userProfile: { ...searchFilter },
          deletedAt: null,
          active: true,
        },
      },
      include: {
        following: {
          include: {
            userProfile: true,
            followers: requesterId
              ? { where: { followerId: requesterId }, select: { followerId: true } }
              : false,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { followerId_followingId: { followerId: userId, followingId: cursor.id } } } : {}),
    });
    return rows;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggested users (for empty search state / trending screen)
// ─────────────────────────────────────────────────────────────────────────────

export async function getSuggestedUsers(requesterId?: string, limit = 8) {
  return prisma.userProfile.findMany({
    where: {
      user: { deletedAt: null, active: true },
      // Exclude requester and people already followed
      ...(requesterId
        ? {
            userId: { not: requesterId },
            user: {
              followers: { none: { followerId: requesterId } },
            },
          }
        : {}),
      isVerified: true,  // Start with verified users for quality
    },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { followersCount: 'desc' },
    take: limit,
  });
}