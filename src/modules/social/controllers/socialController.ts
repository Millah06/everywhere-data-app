// backend/controllers/socialController.ts

import admin from "firebase-admin";
import { calculateAlgorithmScore } from "../services/algorithmService";
import { prisma } from "../../../prisma";
import { resolveUserId } from "../utils/resolveUser";
import { postToClientShape } from "../services/postPresentation";

const db = admin.firestore();

const getFeed = async (req: any, res: any) => {
  try {
    const { limit = 20, lastPostId } = req.query;
    const limitNum = Math.min(parseInt(limit as string), 50);
    const now = new Date();

    const rows = await prisma.post.findMany({
      take: limitNum,
      ...(lastPostId ? { cursor: { id: lastPostId as string }, skip: 1 } : {}),
      orderBy: [{ isBoosted: "desc" }, { createdAt: "desc" }],
    });

    const posts = rows.map((doc) => {
      let isBoosted = doc.isBoosted;
      if (isBoosted && doc.boostExpiresAt && now > doc.boostExpiresAt) {
        isBoosted = false;
        prisma.post
          .update({ where: { id: doc.id }, data: { isBoosted: false } })
          .catch(() => {});
      }
      return postToClientShape({ ...doc, isBoosted });
    });

    res.json({
      success: true,
      posts,
      hasMore: posts.length === limitNum,
    });
  } catch (error) {
    console.error("Get feed error:", error);
    res.status(500).json({ error: "Failed to fetch feed" });
  }
};

const likePost = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { postId } = req.body;

    if (!userId || !postId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const existing = await prisma.postLike.findUnique({
      where: { postId_userId: { postId, userId } },
    });

    if (existing) {
      await prisma.$transaction([
        prisma.postLike.delete({
          where: { postId_userId: { postId, userId } },
        }),
        prisma.post.update({
          where: { id: postId },
          data: { likeCount: { decrement: 1 } },
        }),
      ]);
    } else {
      await prisma.$transaction([
        prisma.postLike.create({ data: { postId, userId } }),
        prisma.post.update({
          where: { id: postId },
          data: { likeCount: { increment: 1 } },
        }),
      ]);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Like post error:", error);
    res.status(500).json({ error: "Failed to like post" });
  }
};

const commentOnPost = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { postId, text } = req.body;

    if (!userId || !postId || !text) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (text.trim().length === 0 || text.length > 300) {
      return res.status(400).json({ error: "Invalid comment length" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { userProfile: true },
    });
    const userName = user?.name || "Anonymous";
    const userAvatar = user?.userProfile?.avatarUrl || null;

    const comment = await prisma.$transaction(async (tx) => {
      const c = await tx.postComment.create({
        data: {
          postId,
          userId,
          userName,
          userAvatar,
          text: text.trim(),
        },
      });
      await tx.post.update({
        where: { id: postId },
        data: { commentCount: { increment: 1 } },
      });
      return c;
    });

    const commentData = {
      commentId: comment.id,
      userUid: userId,
      userName: comment.userName,
      userAvatar: comment.userAvatar,
      text: comment.text,
      createdAt: comment.createdAt.getTime(),
    };

    res.status(201).json({
      success: true,
      comment: commentData,
    });
  } catch (error) {
    console.error("Comment error:", error);
    res.status(500).json({ error: "Failed to add comment" });
  }
};

const getComments = async (req: any, res: any) => {
  try {
    const { postId } = req.params;
    const { limit = 20 } = req.query;

    const rows = await prisma.postComment.findMany({
      where: { postId },
      orderBy: { createdAt: "desc" },
      take: parseInt(limit as string),
    });

    const comments = rows.map((doc) => ({
      commentId: doc.id,
      userUid: doc.userId,
      userName: doc.userName,
      userAvatar: doc.userAvatar,
      text: doc.text,
      createdAt: doc.createdAt.getTime(),
    }));

    res.json({ success: true, comments });
  } catch (error) {
    console.error("Get comments error:", error);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
};

const getTopEarners = async (req: any, res: any) => {
  try {
    const snapshot = await db
      .collection("creatorStats")
      .orderBy("weeklyPoints", "desc")
      .limit(10)
      .get();

    const earners = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const data = doc.data();
        const userDoc = await db.collection("users").doc(doc.id).get();
        const userData = userDoc.data();

        return {
          userId: doc.id,
          userName: userData?.displayName || "Anonymous",
          userAvatar: userData?.photoURL || null,
          totalRewardPoints: data.totalRewardPoints || 0,
          weeklyPoints: data.weeklyPoints || 0,
          totalEarnedNaira: data.totalEarnedNaira || 0,
          level: data.level || 1,
        };
      }),
    );

    res.json({ success: true, earners });
  } catch (error) {
    console.error("Get top earners error:", error);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
};

const getForYouFeed = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { limit = 20, lastPostId } = req.query;
    const limitNum = Math.min(parseInt(limit as string), 50);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { following: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Build query with optional cursor
    const queryOptions: any = {
      take: limitNum,
      orderBy: [{ algorithmScore: "desc" }, { createdAt: "desc" }],
      include: {
        _count: {
          select: { reposts: true },
        },
      },
    };

    // Only add cursor if lastPostId is provided (handles initial load)
    if (lastPostId) {
      queryOptions.cursor = { id: lastPostId as string };
      queryOptions.skip = 1;
    }

    const rows = await prisma.post.findMany(queryOptions);

    console.log("✅ Found", rows.length, "posts");

    const posts = rows.map((doc: any) => {
      let isFollowing = false;
      if (userId && doc.userId !== userId) {
        isFollowing = user.following.some((f) => f.followingId === doc.userId);
      }

        

      return postToClientShape({
        ...doc,
        isFollowing,
        repostCount: doc._count.reposts || 0,
      });
    });

    res.json({
      success: true,
      posts,
      hasMore: posts.length === limitNum,
    });
  } catch (error: any) {
    console.error("❌ Get For You feed error:", error);
    res.status(500).json({ error: "Failed to fetch feed", message: error.message });
  }
};

const getFollowingFeed = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { limit = 20, lastPostId } = req.query;
    const limitNum = Math.min(parseInt(limit as string), 50);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { following: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const followingIds = user.following.map(f => f.followingId);

    if (followingIds.length === 0) {
      return res.json({ success: true, posts: [], hasMore: false });
    }

    const queryOptions: any = {
      where: { userId: { in: followingIds } },
      take: limitNum,
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { reposts: true },
        },
      },
    };

    if (lastPostId) {
      queryOptions.cursor = { id: lastPostId as string };
      queryOptions.skip = 1;
    }

    const rows = await prisma.post.findMany(queryOptions);

    const posts = rows.map((doc: any) => ({
      ...postToClientShape({
        ...doc,
        isFollowing: true,
        repostCount: doc._count.reposts,
      }),
    }));

    res.json({
      success: true,
      posts,
      hasMore: posts.length === limitNum,
    });
  } catch (error: any) {
    console.error("❌ Get Following feed error:", error);
    res.status(500).json({
      error: "Failed to fetch following feed",
      message: error.message,
    });
  }
};

const followUser = async (req: any, res: any) => {
  try {
    const followerId = req.user?.id;
    const { userId: followingId } = req.body;

    if (!followerId || !followingId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (followerId === followingId) {
      return res.status(400).json({ error: "Cannot follow yourself" });
    }

    const followingUser = await prisma.user.findUnique({
      where: { id: followingId },
    });

    if (!followingUser) {
      return res.status(404).json({ error: "User to follow not found" });
    }

    await prisma.$transaction(async (tx) => {
      const existingFollow = await tx.follow.findUnique({
        where: { followerId_followingId: { followerId, followingId } },
      });
      if (existingFollow) {
        throw new Error("Already following this user");
      }
      await tx.follow.create({
        data: {
          followerId,
          followingId,
        },
      });
      await tx.userProfile.update({
        where: { userId: followingId },
        data: {
          followersCount: { increment: 1 },
        },
      });
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error("Follow user error:", error);
    res
      .status(500)
      .json({ error: "Failed to follow user", message: error.message });
  }
};

const unfollowUser = async (req: any, res: any) => {
  try {
    const followerId = req.user?.uid;
    const { userId: followingId } = req.body;

    if (!followerId || !followingId) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (followerId === followingId) {
      return res.status(400).json({ error: "Cannot unfollow yourself" });
    }
    const followingUser = await prisma.user.findUnique({
      where: { id: followingId },
    });

    if (!followingUser) {
      return res.status(404).json({ error: "User to unfollow not found" });
    }
    await prisma.$transaction(async (tx) => {
      const existingFollow = await tx.follow.findUnique({
        where: { followerId_followingId: { followerId, followingId } },
      });
      if (!existingFollow) {
        throw new Error("Not following this user");
      }
      await tx.follow.delete({
        where: { followerId_followingId: { followerId, followingId } },
      });
      await tx.userProfile.update({
        where: { userId: followingId },
        data: {
          followersCount: { decrement: 1 },
        },
      });
      await tx.userProfile.update({
        where: { userId: followerId },
        data: {
          followingCount: { decrement: 1 },
        },
      });
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error("Unfollow user error:", error);
    res
      .status(500)
      .json({ error: "Failed to unfollow user", message: error.message });
  }
};

// backend/controllers/socialController.ts - UPDATE getUserProfile
const getUserProfile = async (req: any, res: any) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user?.id;

    console.log("🔍 Getting profile for userId:", userId);
    console.log("🔍 Current user:", currentUserId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        userProfile: true,
        followers: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Try userProfiles first, fallback to users
    // let profileDoc = await db.collection("userProfiles").doc(userId).get();
    let profileDoc = user.userProfile;

    if (!profileDoc) {
      console.log("❌ Profile not found in userProfiles or users");
      return res.status(404).json({ error: "User not found" });
    }

    // Check if current user follows this user
    let isFollowing = false;

    if (user.followers.some((f) => f.followerId === currentUserId)) {
      isFollowing = true;
    }

    // Get badges
    const badgeDoc = await db.collection("userBadges").doc(userId).get();
    const badges = badgeDoc.exists ? badgeDoc.data()?.badges || {} : {}; // Return {} not []

    const profile = {
      userId,
      username: user.name || "Anonymous",
      displayName: user.name || "Anonymous",
      bio: profileDoc.bio || "",
      chatTag: null,
      transferUID: user.transferUid || null,
      email: user.email || null,
      phoneNumber: user.phone || null,
      avatar: profileDoc.avatarUrl || null,
      coverImage: profileDoc.coverPhotoUrl || null,
      website: profileDoc.website || null,
      location: profileDoc.location || null,
      isPrivate: profileDoc.isPrivate || false,
      allowFollowersToMessage: profileDoc.allowFollwersToMessage || false,
      followerCount: profileDoc.followersCount || 0,
      followingCount: profileDoc.followingCount || 0,
      postCount: profileDoc.postCount || 0,
      repostCount: 0,
      totalRewardPointsEarned: 0,
      totalNairaEarned: profileDoc.totalEarnings || 0,
      weeklyPoints: profileDoc.weeklyEarned || 0,
      isKycVerified: profileDoc.isVerified || false,
      kycVerifiedAt: null,
      createdAt: profileDoc.createdAt.getTime(),
      lastActiveAt: user.updatedAt.getTime(),
      badges,
      isFollowing,
      isFollowingYou: false,
    };

    console.log("✅ Profile loaded successfully");

    res.json({
      success: true,
      profile,
    });
  } catch (error: any) {
    console.error("❌ Get user profile error:", error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
};

const getUserPosts = async (req: any, res: any) => {
  try {
    const { userId: userParam } = req.params;
    const currentUserId = req.user?.id;
    const { limit = 20 } = req.query;

    console.log("📥 Getting posts for user:", userParam);
    console.log("🔍 Current user:", currentUserId);

    const authorId = await resolveUserId(userParam);
    if (!authorId) {
      return res.status(404).json({ error: "User not found" });
    }

    const rows = await prisma.post.findMany({
      where: { userId: authorId },
      orderBy: { createdAt: "desc" },
      take: parseInt(limit as string),
    });

    const authorFb = await prisma.user.findUnique({
      where: { id: authorId },
      include: { followers: true },
    });

    let isFollowing = false;
    if (currentUserId && authorFb && authorFb.id !== currentUserId) {
      isFollowing = authorFb.followers.some((f) => f.followerId === currentUserId);
    }

    const posts = await Promise.all(
      rows.map(async (doc) => {
        let isLiked = false;
        if (currentUserId) {
          const like = await prisma.postLike.findUnique({
            where: {
              postId_userId: { postId: doc.id, userId: currentUserId },
            },
          });
          isLiked = !!like;
        }

        const repostCount = await prisma.repost.count({
          where: { originalPostId: doc.id },
        });

        return postToClientShape({
          ...doc,
          isFollowing,
          isLikedByCurrentUser: isLiked,
          repostCount,
        });
      }),
    );

    console.log("✅ Loaded", posts.length, "posts with like status");

    res.json({ success: true, posts });
  } catch (error: any) {
    console.error("Get user posts error:", error);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
};

// Update createPost to extract hashtags
const createPost = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { text, imageUrl } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: "Post text is required" });
    }

    if (text.length > 500) {
      return res
        .status(400)
        .json({ error: "Post text exceeds 500 characters" });
    }

    const hashtagRegex = /#[\w]+/g;
    const hashtags = (text.match(hashtagRegex) || []).map((tag: string) =>
      tag.toLowerCase(),
    );

    const userDoc = await prisma.userProfile.findUnique({
      where: { userId: userId },
    });
    const user = await prisma.user.findUnique({ where: { id: userId } });

    const postData = {
      userId,
      userName: user?.name || "Anonymous",
      userAvatar: userDoc?.avatarUrl || null,
      text: text.trim(),
      imageUrl: imageUrl || null,
      hashtags,
      likeCount: 0,
      commentCount: 0,
      rewardCount: 0,
      rewardPointsTotal: 0,
      viewCount: 0,
      isBoosted: false,
      boostExpiresAt: null,
      algorithmScore: 10,
    };

    const postRef = await prisma.post.create({ data: postData });

    await prisma.userProfile.updateMany({
      where: { userId },
      data: { postCount: { increment: 1 } },
    });

    res.status(201).json({
      success: true,
      postId: postRef.id,
      post: {
        ...postToClientShape(postRef),
        postId: postRef.id,
      },
    });
  } catch (error: any) {
    console.error("Create post error:", error);
    res.status(500).json({ error: "Failed to create post" });
  }
};

// backend/controllers/socialController.ts - ADD THIS FUNCTION

const deletePost = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { postId } = req.params;
    const { isRepost } = req.body;

    console.log("🗑️ Delete request for post:", postId, "by user:", userId);

    if (!userId || !postId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const postDoc = await prisma.post.findUnique({ where: { id: postId } });

    if (!postDoc) {
      return res.status(404).json({ error: "Post not found" });
    }

    if (postDoc.userId !== userId) {
      return res
        .status(403)
        .json({ error: "You can only delete your own posts" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.repost.deleteMany({
        where: {
          OR: [{ repostPostId: postId }, { originalPostId: postId }],
        },
      });
      await tx.savedPost.deleteMany({ where: { postId } });
      await tx.post.delete({ where: { id: postId } });
      await tx.userProfile.updateMany({
        where: { userId },
        data: { postCount: { decrement: 1 } },
      });
    });

    console.log("✅ Post deleted successfully");

    res.json({ success: true, message: "Post deleted successfully" });
  } catch (error: any) {
    console.error("❌ Delete post error:", error);
    res
      .status(500)
      .json({ error: "Failed to delete post", message: error.message });
  }
};

// backend/controllers/socialController.ts - ADD THIS FUNCTION

const checkLikeStatus = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { postIds } = req.body;

    if (!userId || !postIds || !Array.isArray(postIds)) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    console.log("🔍 Checking like status for", postIds.length, "posts");

    const likeStatus: { [key: string]: boolean } = {};

    for (const postId of postIds) {
      const likeDoc = await prisma.postLike.findUnique({
        where: { postId_userId: { postId, userId } },
      });
      likeStatus[postId] = !!likeDoc;
    }

    console.log("✅ Like status checked");

    res.json({
      success: true,
      likeStatus,
    });
  } catch (error: any) {
    console.error("❌ Check like status error:", error);
    res.status(500).json({ error: "Failed to check like status" });
  }
};

// backend/controllers/socialController.ts - ADD THIS FUNCTION

const getSavedPosts = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { limit = 20 } = req.query;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("📥 Getting saved posts for user:", userId);

    const savedRows = await prisma.savedPost.findMany({
      where: { userId },
      orderBy: { savedAt: "desc" },
      take: parseInt(limit as string),
      include: { post: true },
    });

    if (savedRows.length === 0) {
      return res.json({ success: true, posts: [] });
    }

    console.log("📋 Found", savedRows.length, "saved posts");

    const posts = await Promise.all(
      savedRows.map(async (s) => {
        const data = s.post;
        if (!data) return null;

        let isFollowing = false;
        if (data.userId !== userId) {
          const author = await prisma.user.findUnique({
            where: { id: data.userId },
            include: { followers: true },
          });
          if (author) {
            isFollowing = author.followers.some((f) => f.followerId === userId);
          }
        }

        const likeDoc = await prisma.postLike.findUnique({
          where: {
            postId_userId: { postId: data.id, userId },
          },
        });
        const isLiked = !!likeDoc;

        const repostCount = await prisma.repost.count({
          where: { originalPostId: data.id },
        });

        return postToClientShape({
          ...data,
          isFollowing,
          isLikedByCurrentUser: isLiked,
          isSaved: true,
          repostCount,
        });
      }),
    );

    const validPosts = posts.filter((post) => post !== null);

    console.log(
      "✅ Returning",
      validPosts.length,
      "saved posts with full metadata",
    );

    res.json({
      success: true,
      posts: validPosts,
    });
  } catch (error: any) {
    console.error("❌ Get saved posts error:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch saved posts", message: error.message });
  }
};

export default {
  createPost,
  getFeed, // Keep existing
  getForYouFeed,
  getFollowingFeed,
  likePost,
  commentOnPost,
  getComments,
  getTopEarners,
  followUser,
  unfollowUser,
  getUserProfile,
  getUserPosts,
  deletePost,
  checkLikeStatus,
  getSavedPosts,
};
