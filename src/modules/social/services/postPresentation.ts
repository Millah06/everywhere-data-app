import { Post } from "@prisma/client";

export function postToClientShape(
  p: Post & {
    repostCount?: number;
    isFollowing?: boolean;
    isLikedByCurrentUser?: boolean;
    isSaved?: boolean;
    survey?: any; // embedded by attachSurveys() for survey posts
  },
) {
  return {
    postId: p.id,
    userId: p.userId,
    userName: p.userName,
    userHandle: p.userHandle,
    topBadge: p.topBadge,
    userAvatar: p.userAvatar,
    title: p.title,
    text: p.text,
    images: p.images,
    hashtags: p.hashtags,
    createdAt: p.createdAt.getTime(),
    likeCount: p.likeCount,
    commentCount: p.commentCount,
    giftCount: p.giftCount,
    coinTotal: p.coinTotal,
    viewCount: p.viewCount,
    isBoosted: p.isBoosted,
    boostExpiresAt: p.boostExpiresAt?.getTime() ?? null,
    algorithmScore: p.algorithmScore,
    isRepost: p.isRepost,
    originalPostId: p.originalPostId,
    originalUserName: p.originalUserName,
    originalUserHandle: p.originalUserHandle,
    score: p.score,
    postType: (p as any).postType ?? "standard", // ← NEW: the client needs this
    ...(p.repostCount !== undefined && { repostCount: p.repostCount }),
    ...(p.isFollowing !== undefined && { isFollowing: p.isFollowing }),
    ...(p.isLikedByCurrentUser !== undefined && {
      isLikedByCurrentUser: p.isLikedByCurrentUser,
    }),
    ...(p.isSaved !== undefined && { isSaved: p.isSaved }),
    ...(p.survey !== undefined && p.survey !== null && { survey: p.survey }),
  };
}