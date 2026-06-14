// src/modules/social/controllers/spotlightController.ts
//
// PHASE 10 — "Spotlight" (the repositioned leaderboard).
//
// Two boards, money deliberately HIDDEN from both public payloads:
//   • Top Creators   — most celebrated this week (reuses CreatorStats.weeklyCoins).
//                      No naira in the response — recognition, not a payout chart.
//   • Top Supporters — most generous gifters this week (sum of gifted coins).
//                      This is the high-status "patron" board; conspicuous
//                      generosity is the flex, so the affluent WANT to be here.
//
// Both exclude users who opted out (User.hideFromLeaderboard). Naira/earnings stay
// private to each user's own Earnings tab — never on a public board.

import { prisma } from "../../../prisma";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// GET /social/spotlight/creators
const getTopCreators = async (_req: any, res: any) => {
  try {
    const top = await prisma.creatorStats.findMany({
      where: { user: { hideFromLeaderboardCreators: false } }, // respect opt-out
      orderBy: { weeklyCoins: "desc" },
      take: 10,
      include: {
        user: { select: { name: true, userProfile: { select: { avatarUrl: true } } } },
      },
    });

    const creators = top
      .filter((s) => s.weeklyCoins > 0)
      .map((s) => ({
        userId: s.userId,
        userName: s.user.name,
        userAvatar: s.user.userProfile?.avatarUrl ?? null,
        weeklyCoins: s.weeklyCoins,
        totalCoins: s.totalCoinsEarned,
        level: s.level,
        // NB: no naira — money is private.
      }));

    res.json({ success: true, creators });
  } catch (error: any) {
    console.error("getTopCreators error:", error);
    res.status(500).json({ error: "Failed to fetch creators" });
  }
};

// GET /social/spotlight/supporters
const getTopSupporters = async (_req: any, res: any) => {
  try {
    const since = new Date(Date.now() - WEEK_MS);

    // Sum coins GIFTED per sender this week.
    const grouped = await prisma.giftTransaction.groupBy({
      by: ["senderId"],
      where: { createdAt: { gte: since } },
      _sum: { coinAmount: true },
      _count: { _all: true },
      orderBy: { _sum: { coinAmount: "desc" } },
      take: 30, // over-fetch so we can drop opted-out users and still fill 10
    });

    const senderIds = grouped.map((g) => g.senderId);
    if (senderIds.length === 0) return res.json({ success: true, supporters: [] });

    const users = await prisma.user.findMany({
      where: { id: { in: senderIds }, hideFromLeaderboardSupporters: false },
      select: { id: true, name: true, userProfile: { select: { avatarUrl: true } } },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    const supporters = grouped
      .filter((g) => byId.has(g.senderId))
      .slice(0, 10)
      .map((g) => {
        const u = byId.get(g.senderId)!;
        return {
          userId: g.senderId,
          userName: u.name,
          userAvatar: u.userProfile?.avatarUrl ?? null,
          weeklyCoins: g._sum.coinAmount ?? 0, // coins GIFTED this week
          giftCount: g._count._all,
        };
      });

    res.json({ success: true, supporters });
  } catch (error: any) {
    console.error("getTopSupporters error:", error);
    res.status(500).json({ error: "Failed to fetch supporters" });
  }
};

export default { getTopCreators, getTopSupporters };