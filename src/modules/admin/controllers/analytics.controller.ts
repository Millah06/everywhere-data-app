import { prisma } from "../../../prisma"

// ─────────────────────────────────────────────────────────────────────────────
// LEADERBOARDS & ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/top-users
 * Users with the highest transaction volume
 * Query: limit, type (credit|debit), period (7d|30d|all)
 */
const getTopUsersByVolume = async (req: any, res: any) => {
  try {
    const { limit = "10", type, period = "all" } = req.query as Record<string, string>;

    const periodFilter: { gte?: Date } = {};
    if (period === "7d") periodFilter.gte = new Date(Date.now() - 7 * 86400000);
    if (period === "30d") periodFilter.gte = new Date(Date.now() - 30 * 86400000);

    const result = await prisma.transaction.groupBy({
      by: ["userId"],
      where: {
        status: "success",
        ...(type && { type }),
        ...(periodFilter.gte && { createdAt: periodFilter }),
      },
      _sum: { amount: true },
      _count: { id: true },
      orderBy: { _sum: { amount: "desc" } },
      take: parseInt(limit),
    });

    // Enrich with user details
    const userIds = result.map((r) => r.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        name: true,
        email: true,
        userProfile: { select: { avatarUrl: true } },
      },
    });

    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

    const enriched = result.map((r) => ({
      user: userMap[r.userId],
      totalVolume: r._sum.amount ?? 0,
      transactionCount: r._count.id,
    }));

    return res.json(enriched);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /admin/top-users/balance
 * Users with the highest wallet balances
 */
const getTopUsersByBalance = async (req: any, res: any) => {
  try {
    const { limit = "10" } = req.query as Record<string, string>;

    const fiats = await prisma.fiat.findMany({
      orderBy: { availableBalance: "desc" },
      take: parseInt(limit),
      select: {
        availableBalance: true,
        lockedBalance: true,
        wallet: {
          select: {
            user: {
              select: { id: true, name: true, email: true, userProfile: { select: { avatarUrl: true } } },
            },
          },
        },
      },
    });

    const result = fiats.map((f) => ({
      user: f.wallet.user,
      availableBalance: f.availableBalance,
      lockedBalance: f.lockedBalance,
    }));

    return res.json(result);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /admin/balances/summary
 * Overall wallet balance sheet
 */
const getBalanceSummary = async (req: any, res: any) => {
  try {
    const agg = await prisma.fiat.aggregate({
      _sum: { availableBalance: true, lockedBalance: true, rewardBalance: true },
      _avg: { availableBalance: true },
      _max: { availableBalance: true },
      _min: { availableBalance: true },
    });

    const walletsWithBalance = await prisma.fiat.count({
      where: { availableBalance: { gt: 0 } },
    });

    return res.json({
      totalAvailable: agg._sum.availableBalance ?? 0,
      totalLocked: agg._sum.lockedBalance ?? 0,
      totalRewards: agg._sum.rewardBalance ?? 0,
      averageBalance: agg._avg.availableBalance ?? 0,
      maxBalance: agg._max.availableBalance ?? 0,
      minBalance: agg._min.availableBalance ?? 0,
      walletsWithPositiveBalance: walletsWithBalance,
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default {
  getBalanceSummary,
  getTopUsersByBalance,
  getTopUsersByVolume,
}