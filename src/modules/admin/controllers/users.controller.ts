 
import { prisma } from "../../../prisma";
 



// ─────────────────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/users
 * Paginated list of all users with filters
 * Query: page, limit, role, active, kycStatus, search
 */
const getAllUsers = async (req: any, res: any) => {
  try {
    const {
      page = "1",
      limit = "20",
      role,
      active,
      kycStatus,
      search,
    } = req.query as Record<string, string>;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: any = {
      ...(role && { role }),
      ...(active !== undefined && { active: active === "true" }),
      ...(kycStatus && { kyc: { status: kycStatus } }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { transferUid: { contains: search, mode: "insensitive" } },
        ],
      }),
    };

    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          active: true,
          transferUid: true,
          createdAt: true,
          kyc: { select: { status: true } },
          wallet: {
            select: {
              fiat: { select: { availableBalance: true, lockedBalance: true } },
            },
          },
          userProfile: { select: { avatarUrl: true, isVerified: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    return res.json({
      data: users,
      meta: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /admin/users/:userId
 * Full profile of a single user including wallet and recent transactions
 */
const getUserDetail = async (req: any, res: any) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        kyc: true,
        wallet: { include: { fiat: true } },
        userProfile: true,
        virtualAccount: true,
        transactions: {
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            type: true,
            amount: true,
            status: true,
            message: true,
            transactionRef: true,
            createdAt: true,
          },
        },
      },
    });

    if (!user) return res.status(404).json({ message: "User not found." });

    return res.json(user);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * PATCH /admin/users/:userId/block
 * Block or unblock a user
 * Body: { active: boolean, reason? }
 */
const setUserActiveStatus = async (req: any, res: any) => {  try {
    const { userId } = req.params;
    const { active, reason } = req.body;

    if (typeof active !== "boolean") {
      return res.status(400).json({ message: "`active` (boolean) is required." });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found." });
    if (user.role === "admin") {
      return res.status(403).json({ message: "Cannot block another admin." });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { active },
      select: { id: true, name: true, email: true, active: true },
    });

    // Optionally disable the Firebase account too
    const { getAuth } = await import("firebase-admin/auth");
    await getAuth().updateUser(user.firebaseUid, { disabled: !active });

    return res.json({
      ...updated,
      message: active ? "User unblocked." : `User blocked${reason ? `: ${reason}` : "."}`,
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * PATCH /admin/users/:userId/role
 * Promote/demote user role
 * Body: { role: "user" | "vendor" | "admin" }
 */
const updateUserRole = async (req: any, res: any) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    const allowed = ["user", "vendor", "admin"];
    if (!allowed.includes(role)) {
      return res.status(400).json({ message: `role must be one of: ${allowed.join(", ")}` });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found." });

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { role },
      select: { id: true, name: true, role: true },
    });

    // Sync Firebase custom claims
    const { getAuth } = await import("firebase-admin/auth");
    await getAuth().setCustomUserClaims(user.firebaseUid, { role, postgresId: userId });

    return res.json(updated);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * PATCH /admin/users/:userId/kyc
 * Manually approve or reject a user's KYC
 * Body: { status: "verified" | "rejected", reason? }
 */
const updateKycStatus = async (req: any, res: any) => {
  try {
    const { userId } = req.params;
    const { status, reason } = req.body;

    if (!["verified", "rejected"].includes(status)) {
      return res.status(400).json({ message: "status must be 'verified' or 'rejected'." });
    }

    const kyc = await prisma.kyc.findUnique({ where: { userId } });
    if (!kyc) return res.status(404).json({ message: "KYC record not found." });

    const updated = await prisma.kyc.update({
      where: { userId },
      data: {
        status,
        document: { ...(kyc.document as object ?? {}), reviewNote: reason, reviewedAt: new Date().toISOString() },
      },
    });

    // Update isVerified flag on profile
    await prisma.userProfile.update({
      where: { userId },
      data: { isVerified: status === "verified" },
    });

    return res.json(updated);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};


export default {
  getAllUsers,
  getUserDetail,
  updateKycStatus,
  setUserActiveStatus,
  updateUserRole, 
}

