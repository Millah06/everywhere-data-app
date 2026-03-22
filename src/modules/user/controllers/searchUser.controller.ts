import {prisma} from "../../../prisma"

/**
 * GET /users/search?q=...
 * Search users by name or email (admin or internal use)
 */
export const searchUsers = async (req: any, res: any) => {
  try {
    const { q, page = "1", limit = "20" } = req.query as Record<string, string>;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ message: "Query must be at least 2 characters." });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { transferUid: { contains: q, mode: "insensitive" } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          active: true,
          transferUid: true,
          createdAt: true,
          userProfile: { select: { avatarUrl: true, isVerified: true } },
        },
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
      }),
      prisma.user.count({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { transferUid: { contains: q, mode: "insensitive" } },
          ],
        },
      }),
    ]);

    return res.json({
      data: users,
      meta: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default {
    searchUsers 
};