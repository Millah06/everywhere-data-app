import { Post } from "@prisma/client";

export function postToClientShape(
  p: Post & { repostCount?: number; isFollowing?: boolean; isLikedByCurrentUser?: boolean; isSaved?: boolean },
) {
  return {
    postId: p.id,
    userId: p.userId,
    userName: p.userName,
    userAvatar: p.userAvatar,
    text: p.text,
    imageUrl: p.imageUrl,
    hashtags: p.hashtags,
    createdAt: p.createdAt.getTime(),
    likeCount: p.likeCount,
    commentCount: p.commentCount,
    rewardCount: p.rewardCount,
    rewardPointsTotal: p.rewardPointsTotal,
    viewCount: p.viewCount,
    isBoosted: p.isBoosted,
    boostExpiresAt: p.boostExpiresAt?.getTime() ?? null,
    algorithmScore: p.algorithmScore,
    isRepost: p.isRepost,
    originalPostId: p.originalPostId,
    originalUserName: p.originalUserName,
    score: p.score,
    ...(p.repostCount !== undefined && { repostCount: p.repostCount }),
    ...(p.isFollowing !== undefined && { isFollowing: p.isFollowing }),
    ...(p.isLikedByCurrentUser !== undefined && {
      isLikedByCurrentUser: p.isLikedByCurrentUser,
    }),
    ...(p.isSaved !== undefined && { isSaved: p.isSaved }),
  };
}
