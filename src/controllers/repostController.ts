// backend/controllers/repostController.ts

import admin from 'firebase-admin';
import { calculateAlgorithmScore } from '../utils/algorithmService';

const db = admin.firestore();

const repostPost = async (req: any, res: any) => {
  try {
    const reposterId = req.user?.uid;
    const { postId, text } = req.body;

    if (!reposterId || !postId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get original post
    const originalPostDoc = await db.collection('posts').doc(postId).get();

    if (!originalPostDoc.exists) {
      return res.status(404).json({ error: 'Original post not found' });
    }

    const originalPost = originalPostDoc.data();

    // Check if already reposted
    const existingRepost = await db
      .collection('reposts')
      .where('originalPostId', '==', postId)
      .where('reposterId', '==', reposterId)
      .limit(1)
      .get();

    if (!existingRepost.empty) {
      return res.status(400).json({ error: 'You have already reposted this' });
    }

    // Get reposter info
    const reposterDoc = await db.collection('users').doc(reposterId).get();
    const reposterData = reposterDoc.data();

    // Create repost (new post document)
    const repostRef = db.collection('posts').doc();
    
    const repostData = {
      userId: reposterId,
      userName: reposterData?.displayName || reposterData?.name || 'Anonymous',
      userAvatar: reposterData?.photoURL || reposterData?.photoUrl || null,
      text: text || originalPost?.text || '',
      imageUrl: originalPost?.imageUrl || null, // Reuse original image
      hashtags: originalPost?.hashtags || [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      likeCount: 0,
      commentCount: 0,
      viewCount: 0,
      rewardCount: 0,
      rewardPointsTotal: 0,
      isBoosted: false,
      boostExpiresAt: null,
      isRepost: true,
      originalPostId: postId,
      originalUserName: originalPost?.userName || 'Unknown',
      score: 10, // Initial score
    };

    await repostRef.set(repostData);

    // Record repost
    await db.collection('reposts').doc(repostRef.id).set({
      repostId: repostRef.id,
      originalPostId: postId,
      reposterId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update reposter's repost count
    await db.collection('userProfiles').doc(reposterId).update({
      repostCount: admin.firestore.FieldValue.increment(1),
    });

    res.status(201).json({
      success: true,
      repostId: repostRef.id,
      post: { ...repostData, postId: repostRef.id, createdAt: Date.now() },
    });
  } catch (error: any) {
    console.error('Repost error:', error);
    res.status(500).json({ error: 'Failed to repost', message: error.message });
  }
};

const getRepostCount = async (req: any, res: any) => {
  try {
    const { postId } = req.params;

    const repostSnapshot = await db
      .collection('reposts')
      .where('originalPostId', '==', postId)
      .get();

    res.json({ success: true, count: repostSnapshot.size });
  } catch (error: any) {
    console.error('Get repost count error:', error);
    res.status(500).json({ error: 'Failed to get repost count' });
  }
};

export default {
  repostPost,
  getRepostCount,
};