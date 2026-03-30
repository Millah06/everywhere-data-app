import { prisma } from "../../../prisma";
import { uploadImage } from "../../../shared/services/uploadImage.service";

/**
 * PATCH /users/me/profile
 * Update user profile fields: bio, avatarUrl, isPrivate, allowFollowersToMessage
 */
export const updateProfile = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { bio, avatarUrl, isPrivate, allowFollwersToMessage } = req.body;

    const updated = await prisma.userProfile.update({
      where: { userId: userId },
      data: {
        ...(bio !== undefined && { bio }),
        ...(avatarUrl !== undefined && { avatarUrl }),
        ...(isPrivate !== undefined && { isPrivate }),
        ...(allowFollwersToMessage !== undefined && { allowFollwersToMessage }),
      },
    });

    return res.json(updated);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * PATCH /users/me/notification-token
 * Store push notification token (FCM token from device)
 * Body: { token, enabled? }
 */
export const updateNotificationToken = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { token, enabled } = req.body;
    if (!token) return res.status(400).json({ message: "token is required." });

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        notificationToken: token,
        ...(enabled !== undefined && { notificationsEnabled: enabled }),
      },
      select: { id: true, notificationsEnabled: true },
    });

    return res.json(updated);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /users/referral-stats
 * Returns how many users this user has referred
 */
export const getReferralStats = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });

    if (!user?.referralCode) {
      return res.json({ referralCode: null, referredCount: 0 });
    }

    const referredCount = await prisma.user.count({
      where: { referredBy: user.referralCode },
    });

    return res.json({ referralCode: user.referralCode, referredCount });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

const uploadProfilePicture = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    if (!req.file)
      return res.status(400).json({ message: "No image file provided" });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { userProfile: true },
    });
    if (!user) return res.status(404).json({ message: "User not found" });

    const imageUrl = await uploadImage(req.file, userId, "userProfilePicture");

    await prisma.user.update({
      where: { id: userId },
      data: {
        userProfile: {
          update: { avatarUrl: imageUrl },
        },
      },
    });

    res.json({ success: true, imageUrl });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const uploadCoverPhoto = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    if (!req.file)
      return res.status(400).json({ message: "No image file provided" });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { userProfile: true },
    });
    if (!user) return res.status(404).json({ message: "User not found" });

    const imageUrl = await uploadImage(req.file, userId, "userCoverPhoto");

    await prisma.user.update({
      where: { id: userId },
      data: {
        userProfile: {
          update: { coverPhotoUrl: imageUrl },
        },
      },
    });

    res.json({ success: true, imageUrl });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
    updateNotificationToken,
    updateProfile,
    getReferralStats,
    uploadProfilePicture,
    uploadCoverPhoto
}