// backend/utils/algorithmService.ts
import * as admin from 'firebase-admin';

export const calculateAlgorithmScore = async (postData: any, db: any): Promise<number> => {
  const now = Date.now();
  const postTime = postData.createdAt?.toMillis() || now;
  const ageInHours = (now - postTime) / (1000 * 60 * 60);

  // Recency weight
  let recencyWeight = 0;
  if (ageInHours < 1) recencyWeight = 50;
  else if (ageInHours < 6) recencyWeight = 30;
  else if (ageInHours < 24) recencyWeight = 10;

  // Get creator's follower count
  let followerBoost = 0;
  try {
    const creatorProfile = await db.collection('userProfiles').doc(postData.userId).get();
    if (creatorProfile.exists) {
      const followerCount = creatorProfile.data()?.followerCount || 0;
      // Follower boost: logarithmic scale (prevents mega-influencers from dominating)
      followerBoost = Math.log10(followerCount + 1) * 5; // Max ~15 for 1M followers
    }
  } catch (error) {
    console.error('Error getting follower count:', error);
  }

  // Enhanced algorithm
  const score = 
    (postData.rewardCount || 0) * 0.5 +
    (postData.viewCount || 0) * 0.2 +
    (postData.likeCount || 0) * 0.2 +
    recencyWeight * 0.1 +
    followerBoost * 0.1;  // NEW: Follower influence

  return Math.round(score * 100) / 100; // Round to 2 decimals
};

export const updatePostScore = async (postId: string, db: any) => {
  try {
    const postRef = db.collection('posts').doc(postId);
    const postDoc = await postRef.get();
    
    if (!postDoc.exists) return;
    
    const score = await calculateAlgorithmScore(postDoc.data(), db);
    
    await postRef.update({
      score,
      lastScoreUpdate: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('Error updating post score:', error);
  }
};