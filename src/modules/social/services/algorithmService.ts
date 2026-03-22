import { prisma } from "../../../prisma";

export const calculateAlgorithmScore = async (postId: string) => {
  const postData = await prisma.post.findUnique({
    where: { id: postId },
    include: { user: { include: { userProfile: true } } },
  });

  if (!postData) return 0;

  const creatorProfile = postData.user?.userProfile;
  const followerCount = creatorProfile?.followersCount ?? 0;

  const likeWeight = 2;
  const commentWeight = 3;
  const viewWeight = 0.1;
  const followerWeight = 0.5;

  const engagementScore =
    postData.likeCount * likeWeight +
    postData.commentCount * commentWeight +
    postData.viewCount * viewWeight;

  const followerBoost = Math.log10(followerCount + 10) * followerWeight;

  const timeDecay = 1;
  const score = (engagementScore + followerBoost) * timeDecay;

  await prisma.post.update({
    where: { id: postId },
    data: {
      algorithmScore: score,
      updatedAt: new Date(),
    },
  });

  return score;
};

/** @param _db ignored — kept for backward compatibility with older callers */
export const updatePostScore = async (postId: string, _db?: unknown) => {
  return calculateAlgorithmScore(postId);
};
