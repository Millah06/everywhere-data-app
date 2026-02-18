// backend/utils/algorithmService.ts

export const calculateAlgorithmScore = (post: any): number => {
  const now = Date.now();
  const postTime = post.createdAt?.toMillis() || now;
  const ageInHours = (now - postTime) / (1000 * 60 * 60);

  // Recency weight
  let recencyWeight = 0;
  if (ageInHours < 1) recencyWeight = 50;
  else if (ageInHours < 6) recencyWeight = 30;
  else if (ageInHours < 24) recencyWeight = 10;

  // Algorithm score
  const score = 
    (post.rewardCount || 0) * 0.5 +
    (post.viewCount || 0) * 0.2 +
    (post.likeCount || 0) * 0.2 +
    recencyWeight * 0.1;

  return score;
};