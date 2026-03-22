import {prisma} from "../../../prisma"

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/stats
 * High-level dashboard numbers: users, balances, transaction volumes
 */
const getDashboardStats = async (req: any, res: any) => {
  try {
    const [
      totalUsers,
      activeUsers,
      blockedUsers,
      verifiedKyc,
      pendingKyc,
      balanceAgg,
      txStats,
      newUsersToday,
    ] = await prisma.$transaction([
      prisma.user.count(),
      prisma.user.count({ where: { active: true } }),
      prisma.user.count({ where: { active: false } }),
      prisma.kyc.count({ where: { status: "verified" } }),
      prisma.kyc.count({ where: { status: "pending" } }),
      // Sum all fiat balances
      prisma.fiat.aggregate({
        _sum: { availableBalance: true, lockedBalance: true, rewardBalance: true },
      }),
      // Transaction volume & counts
      prisma.transaction.groupBy({
        by: ["status"],
        _sum: { amount: true },
        _count: { id: true },
        orderBy: {status: "asc"}
      }),
      // New users today
      prisma.user.count({
        where: {
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
    ]);

    const txByStatus = Object.fromEntries(
      txStats.map((s) => [
        s.status,
        { count: s._count, volume: s._sum?.amount ?? 0 },
      ])
    );

    return res.json({
      users: { total: totalUsers, active: activeUsers, blocked: blockedUsers, newToday: newUsersToday },
      kyc: { verified: verifiedKyc, pending: pendingKyc },
      balances: {
        totalAvailable: balanceAgg._sum.availableBalance ?? 0,
        totalLocked: balanceAgg._sum.lockedBalance ?? 0,
        totalRewards: balanceAgg._sum.rewardBalance ?? 0,
      },
      transactions: txByStatus,
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default {
  getDashboardStats
}