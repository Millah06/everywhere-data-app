
import { prisma } from "../../..//prisma";

/**
 * GET /users/me
 * Returns the authenticated user's full profile
 */
export const getMe = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });


    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        active: true,
        referralCode: true,
        transferUid: true,
        notificationsEnabled: true,
        createdAt: true,
        kyc: { select: { id: true, status: true } },
        wallet: {
          select: {
            fiat: {
              select: {
                availableBalance: true,
                lockedBalance: true,
                rewardBalance: true,
              },
            },
          },
        },
        userProfile: true,
        virtualAccount: {
          select: { id: true, bankName: true, accountNumber: true, status: true },
        },
      },
    });

    if (!user) return res.status(404).json({ message: "User not found." });

    return res.json(user);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default {
    getMe
}