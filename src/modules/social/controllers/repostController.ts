// backend/controllers/repostController.ts

import { prisma } from "../../../prisma";

const repostPost = async (req: any, res: any) => {
  try {
    const reposterPrismaId = req.user?.id;
    const { postId, text } = req.body;

    if (!reposterPrismaId || !postId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const originalPostDoc = await prisma.post.findUnique({
      where: {
        id: postId,
      },
    });

    if (!originalPostDoc) {
      return res.status(404).json({ error: "Original post not found" });
    }

    const existingRepost = await prisma.repost.findFirst({
      where: {
        originalPostId: postId,
        reposterId: reposterPrismaId,
      },
    });

    if (existingRepost) {
      return res.status(400).json({ error: "You have already reposted this" });
    }

    const reposter = await prisma.user.findUnique({
      where: { id: reposterPrismaId },
      include: { userProfile: true },
    });

    const repostData = {
      userId: reposterPrismaId,
      userName: reposter?.name || "Anonymous",
      userHandle: reposter?.userProfile?.userName || '',
      userAvatar: reposter?.userProfile?.avatarUrl || null,
      text: text || originalPostDoc.text || "",
      images: originalPostDoc.images || null,
      hashtags: originalPostDoc.hashtags || [],
      likeCount: 0,
      commentCount: 0,
      viewCount: 0,
      rewardCount: 0,
      rewardPointsTotal: 0,
      isBoosted: false,
      boostExpiresAt: null,
      isRepost: true,
      originalPostId: postId,
      originalUserName: originalPostDoc.userName || "Unknown",
      originalUserHandle: originalPostDoc.userHandle,
      algorithmScore: 10,
    };

    const created = await prisma.$transaction(async (tx) => {
      const post = await tx.post.create({ data: repostData });
      await tx.repost.create({
        data: {
          repostPostId: post.id,
          originalPostId: postId,
          reposterId: reposterPrismaId,
        },
      });
      await tx.userProfile.updateMany({
        where: { userId: reposterPrismaId },
        data: { postCount: { increment: 1 } },
      });
      return post;
    });

    res.status(201).json({
      success: true,
      repostId: created.id,
      post: {
        ...repostData,
        postId: created.id,
        createdAt: Date.now(),
      },
    });
  } catch (error: any) {
    console.error("Repost error:", error);
    res.status(500).json({ error: "Failed to repost", message: error.message });
  }
};

const getRepostCount = async (req: any, res: any) => {
  try {
    const { postId } = req.params;

    const count = await prisma.repost.count({
      where: { originalPostId: postId },
    });

    res.json({ success: true, count });
  } catch (error: any) {
    console.error("Get repost count error:", error);
    res.status(500).json({ error: "Failed to get repost count" });
  }
};

export default {
  repostPost,
  getRepostCount,
};
