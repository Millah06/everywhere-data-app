// backend/controllers/socialController.ts

import admin from 'firebase-admin';
import { checkAuth } from '../webhook/utils/auth';

const db = admin.firestore();

const createPost = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req); // Verify auth
    // const userId = req.user?.uid;
    const { text, imageUrl } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Post text is required' });
    }

    if (text.length > 500) {
      return res.status(400).json({ error: 'Post text exceeds 500 characters' });
    }

    // Get user info
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    const postData = {
      userId,
      userName: userData?.displayName || 'Anonymous',
      userAvatar: userData?.photoURL || null,
      text: text.trim(),
      imageUrl: imageUrl || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      likeCount: 0,
      commentCount: 0,
      rewardCount: 0,
      rewardPointsTotal: 0,
      isBoosted: false,
      boostExpiresAt: null,
    };

    const postRef = await db.collection('posts').add(postData);

    res.status(201).json({
      success: true,
      postId: postRef.id,
      post: { ...postData, postId: postRef.id },
    });
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: 'Failed to create post' });
  }
};

const getFeed = async (req: any, res: any) => {
  try {
    const { limit = 20, lastPostId } = req.query;
    const limitNum = Math.min(parseInt(limit as string), 50);

    let query = db
      .collection('posts')
      .orderBy('isBoosted', 'desc')
      .orderBy('createdAt', 'desc')
      .limit(limitNum);

    if (lastPostId) {
      const lastDoc = await db.collection('posts').doc(lastPostId as string).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
    }

    const snapshot = await query.get();
    const now = Date.now();

    const posts = snapshot.docs.map((doc) => {
      const data = doc.data();
      
      // Check if boost expired
      let isBoosted = data.isBoosted;
      if (isBoosted && data.boostExpiresAt) {
        const expiresAt = data.boostExpiresAt.toMillis();
        if (now > expiresAt) {
          isBoosted = false;
          // Update asynchronously
          doc.ref.update({ isBoosted: false });
        }
      }

      return {
        postId: doc.id,
        ...data,
        isBoosted,
        createdAt: data.createdAt?.toMillis() || Date.now(),
      };
    });

    res.json({
      success: true,
      posts,
      hasMore: posts.length === limitNum,
    });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
};

const likePost = async (req: any, res: any) => {
  try {

    const userId = await checkAuth(req); // Verify auth
    // const userId = req.user?.uid;
    const { postId } = req.body;

    if (!userId || !postId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const postRef = db.collection('posts').doc(postId);
    const likeRef = postRef.collection('likes').doc(userId);

    await db.runTransaction(async (transaction) => {
      const likeDoc = await transaction.get(likeRef);

      if (likeDoc.exists) {
        // Unlike
        transaction.delete(likeRef);
        transaction.update(postRef, {
          likeCount: admin.firestore.FieldValue.increment(-1),
        });
      } else {
        // Like
        transaction.set(likeRef, {
          userId,
          likedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        transaction.update(postRef, {
          likeCount: admin.firestore.FieldValue.increment(1),
        });
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Like post error:', error);
    res.status(500).json({ error: 'Failed to like post' });
  }
};

const commentOnPost = async (req: any, res: any) => {
  try {

    const userId = await checkAuth(req); // Verify auth
    // const userId = req.user?.uid;
    const { postId, text } = req.body;

    if (!userId || !postId || !text) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (text.trim().length === 0 || text.length > 300) {
      return res.status(400).json({ error: 'Invalid comment length' });
    }

    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    const postRef = db.collection('posts').doc(postId);
    const commentRef = postRef.collection('comments').doc();

    const commentData = {
      commentId: commentRef.id,
      userId,
      userName: userData?.displayName || 'Anonymous',
      userAvatar: userData?.photoURL || null,
      text: text.trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.runTransaction(async (transaction) => {
      transaction.set(commentRef, commentData);
      transaction.update(postRef, {
        commentCount: admin.firestore.FieldValue.increment(1),
      });
    });

    res.status(201).json({
      success: true,
      comment: commentData,
    });
  } catch (error) {
    console.error('Comment error:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
};

const getComments = async (req: any, res: any) => {
  try {
    const { postId } = req.params;
    const { limit = 20 } = req.query;

    const snapshot = await db
      .collection('posts')
      .doc(postId)
      .collection('comments')
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit as string))
      .get();

    const comments = snapshot.docs.map((doc) => ({
      ...doc.data(),
      createdAt: doc.data().createdAt?.toMillis() || Date.now(),
    }));

    res.json({ success: true, comments });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
};

const getTopEarners = async (req: any, res: any) => {
  try {
    const snapshot = await db
      .collection('creatorStats')
      .orderBy('weeklyPoints', 'desc')
      .limit(10)
      .get();

    const earners = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const data = doc.data();
        const userDoc = await db.collection('users').doc(doc.id).get();
        const userData = userDoc.data();

        return {
          userId: doc.id,
          userName: userData?.displayName || 'Anonymous',
          userAvatar: userData?.photoURL || null,
          totalRewardPoints: data.totalRewardPoints || 0,
          weeklyPoints: data.weeklyPoints || 0,
          totalEarnedNaira: data.totalEarnedNaira || 0,
          level: data.level || 1,
        };
      })
    );

    res.json({ success: true, earners });
  } catch (error) {
    console.error('Get top earners error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
};

export default {
  createPost,
  getFeed,
  likePost,
  commentOnPost,
  getComments,
  getTopEarners,
};