// backend/controllers/downloadController.ts - SIMPLE FALLBACK

import { prisma } from "../../../prisma";

const generatePostDownload = async (req: any, res: any) => {
  try {
    const { postId } = req.body;

    console.log("📥 Download request for post:", postId);

    if (!postId) {
      return res.status(400).json({ error: "Missing postId" });
    }

    const postData = await prisma.post.findUnique({ where: { id: postId } });

    if (!postData) {
      return res.status(404).json({ error: "Post not found" });
    }

    if (!postData?.images) {
      return res.status(400).json({ error: "Post has no image" });
    }

    console.log("✅ Returning image metadata for client-side processing");

    // this needs attention
    res.json({
      success: true,
      imageUrls: postData.images,
      caption: postData.text || "",
      username: postData.userName || "user",
      processOnClient: true,
    });
  } catch (error: any) {
    console.error("❌ Download error:", error);
    res.status(500).json({
      error: "Failed to generate download",
      message: error.message,
    });
  }
};

export default {
  generatePostDownload,
};
