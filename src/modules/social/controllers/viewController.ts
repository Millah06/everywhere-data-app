// backend/controllers/viewController.ts

import { prisma } from "../../../prisma";
import { updatePostScore } from "../services/algorithmService";

const incrementView = async (req: any, res: any) => {
  try {
    const viewerPrismaId = req.user?.id;
    const { postId } = req.body;

    if (!viewerPrismaId || !postId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const postDoc = await prisma.post.findUnique({ where: { id: postId } });

    if (!postDoc) {
      return res.status(404).json({ error: "Post not found" });
    }

    if (postDoc.userId === viewerPrismaId) {
      return res.json({ success: true, counted: false, reason: "own_post" });
    }

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const existing = await prisma.postViewTracker.findUnique({
      where: {
        postId_viewerId: { postId, viewerId: viewerPrismaId },
      },
    });

    let shouldCount = false;

    if (!existing) {
      shouldCount = true;
      await prisma.postViewTracker.create({
        data: {
          postId,
          viewerId: viewerPrismaId,
          lastViewedAt: now,
          viewCount: 1,
        },
      });
    } else if (existing.lastViewedAt < oneDayAgo) {
      shouldCount = true;
      await prisma.postViewTracker.update({
        where: {
          postId_viewerId: { postId, viewerId: viewerPrismaId },
        },
        data: {
          lastViewedAt: now,
          viewCount: { increment: 1 },
        },
      });
    }

    if (shouldCount) {
      await prisma.post.update({
        where: { id: postId },
        data: { viewCount: { increment: 1 } },
      });

      await updatePostScore(postId, prisma);

      return res.json({ success: true, counted: true });
    }

    return res.json({
      success: true,
      counted: false,
      reason: "recently_viewed",
    });
  } catch (error: any) {
    console.error("Increment view error:", error);
    res
      .status(500)
      .json({ error: "Failed to increment view", message: error.message });
  }
};

export default {
  incrementView,
};
