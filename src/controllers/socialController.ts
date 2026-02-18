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

// backend/controllers/socialController.ts - ADD THESE FUNCTIONS

const getForYouFeed = async (req: any, res: any) => {
  try {
    const userId = req.user?.uid;
    const { limit = 20, lastScore, lastPostId } = req.query;
    const limitNum = Math.min(parseInt(limit as string), 50);

    let query = db
      .collection('posts')
      .orderBy('algorithmScore', 'desc')
      .orderBy('createdAt', 'desc')
      .limit(limitNum);

    if (lastScore && lastPostId) {
      const lastDoc = await db.collection('posts').doc(lastPostId as string).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
    }

    const snapshot = await query.get();
    const posts = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const data = doc.data();
        
        // Check if user is following post author
        let isFollowing = false;
        if (userId && data.userId !== userId) {
          const followDoc = await db
            .collection('follows')
            .where('followerId', '==', userId)
            .where('followingId', '==', data.userId)
            .limit(1)
            .get();
          isFollowing = !followDoc.empty;
        }

        return {
          postId: doc.id,
          userId: data.userId || '',
          userName: data.userName || 'Anonymous',
          userAvatar: data.userAvatar || null,
          text: data.text || '',
          imageUrl: data.imageUrl || null,
          hashtags: data.hashtags || [],
          createdAt: data.createdAt?.toMillis() || Date.now(),
          likeCount: data.likeCount || 0,
          commentCount: data.commentCount || 0,
          rewardCount: data.rewardCount || 0,
          rewardPointsTotal: data.rewardPointsTotal || 0,
          viewCount: data.viewCount || 0,
          isBoosted: data.isBoosted || false,
          boostExpiresAt: data.boostExpiresAt?.toMillis() || null,
          algorithmScore: data.algorithmScore || 0,
          isFollowing,
        };
      })
    );

    res.json({
      success: true,
      posts,
      hasMore: posts.length === limitNum,
    });
  } catch (error: any) {
    console.error('Get For You feed error:', error);
    res.status(500).json({ error: 'Failed to fetch feed', message: error.message });
  }
};

const getFollowingFeed = async (req: any, res: any) => {
  try {
    const userId = req.user?.uid;
    const { limit = 20, lastPostId } = req.query;
    const limitNum = Math.min(parseInt(limit as string), 50);

    // Get users that current user follows
    const followingSnapshot = await db
      .collection('follows')
      .where('followerId', '==', userId)
      .get();

    const followingIds = followingSnapshot.docs.map(doc => doc.data().followingId);

    if (followingIds.length === 0) {
      return res.json({ success: true, posts: [], hasMore: false });
    }

    // Get posts from followed users (Firestore 'in' supports max 10 values)
    // For production, implement pagination properly
    const chunks = [];
    for (let i = 0; i < followingIds.length; i += 10) {
      chunks.push(followingIds.slice(i, i + 10));
    }

    let allPosts: any[] = [];
    
    for (const chunk of chunks) {
      let query = db
        .collection('posts')
        .where('userId', 'in', chunk)
        .orderBy('createdAt', 'desc')
        .limit(limitNum);

      if (lastPostId) {
        const lastDoc = await db.collection('posts').doc(lastPostId as string).get();
        if (lastDoc.exists) {
          query = query.startAfter(lastDoc);
        }
      }

      const snapshot = await query.get();
      const posts = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          postId: doc.id,
          userId: data.userId || '',
          userName: data.userName || 'Anonymous',
          userAvatar: data.userAvatar || null,
          text: data.text || '',
          imageUrl: data.imageUrl || null,
          hashtags: data.hashtags || [],
          createdAt: data.createdAt?.toMillis() || Date.now(),
          likeCount: data.likeCount || 0,
          commentCount: data.commentCount || 0,
          rewardCount: data.rewardCount || 0,
          rewardPointsTotal: data.rewardPointsTotal || 0,
          viewCount: data.viewCount || 0,
          isBoosted: data.isBoosted || false,
          boostExpiresAt: data.boostExpiresAt?.toMillis() || null,
          isFollowing: true, // All posts are from followed users
        };
      });

      allPosts = allPosts.concat(posts);
    }

    // Sort by createdAt desc
    allPosts.sort((a, b) => b.createdAt - a.createdAt);
    allPosts = allPosts.slice(0, limitNum);

    res.json({
      success: true,
      posts: allPosts,
      hasMore: allPosts.length === limitNum,
    });
  } catch (error: any) {
    console.error('Get Following feed error:', error);
    res.status(500).json({ error: 'Failed to fetch following feed', message: error.message });
  }
};

const followUser = async (req: any, res: any) => {
  try {
    const followerId = req.user?.uid;
    const { userId: followingId } = req.body;

    if (!followerId || !followingId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (followerId === followingId) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    const followRef = db.collection('follows').doc();

    await db.runTransaction(async (transaction) => {
      // Check if already following
      const existingFollow = await db
        .collection('follows')
        .where('followerId', '==', followerId)
        .where('followingId', '==', followingId)
        .limit(1)
        .get();

      if (!existingFollow.empty) {
        throw new Error('Already following this user');
      }

      // Create follow
      transaction.set(followRef, {
        followId: followRef.id,
        followerId,
        followingId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update follower count
      const followerProfileRef = db.collection('userProfiles').doc(followingId);
      transaction.update(followerProfileRef, {
        followerCount: admin.firestore.FieldValue.increment(1),
      });

      // Update following count
      const followingProfileRef = db.collection('userProfiles').doc(followerId);
      transaction.update(followingProfileRef, {
        followingCount: admin.firestore.FieldValue.increment(1),
      });
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('Follow user error:', error);
    res.status(500).json({ error: 'Failed to follow user', message: error.message });
  }
};

const unfollowUser = async (req: any, res: any) => {
  try {
    const followerId = req.user?.uid;
    const { userId: followingId } = req.body;

    if (!followerId || !followingId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await db.runTransaction(async (transaction) => {
      // Find follow document
      const followSnapshot = await db
        .collection('follows')
        .where('followerId', '==', followerId)
        .where('followingId', '==', followingId)
        .limit(1)
        .get();

      if (followSnapshot.empty) {
        throw new Error('Not following this user');
      }

      const followDoc = followSnapshot.docs[0];

      // Delete follow
      transaction.delete(followDoc.ref);

      // Update follower count
      const followerProfileRef = db.collection('userProfiles').doc(followingId);
      transaction.update(followerProfileRef, {
        followerCount: admin.firestore.FieldValue.increment(-1),
      });

      // Update following count
      const followingProfileRef = db.collection('userProfiles').doc(followerId);
      transaction.update(followingProfileRef, {
        followingCount: admin.firestore.FieldValue.increment(-1),
      });
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('Unfollow user error:', error);
    res.status(500).json({ error: 'Failed to unfollow user', message: error.message });
  }
};

const incrementPostView = async (req: any, res: any) => {
  try {
    const { postId } = req.body;

    if (!postId) {
      return res.status(400).json({ error: 'Missing postId' });
    }

    const postRef = db.collection('posts').doc(postId);

    await postRef.update({
      viewCount: admin.firestore.FieldValue.increment(1),
    });

    // Recalculate algorithm score
    const postDoc = await postRef.get();
    if (postDoc.exists) {
      const score = calculateAlgorithmScore(postDoc.data());
      await postRef.update({ algorithmScore: score });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Increment view error:', error);
    res.status(500).json({ error: 'Failed to increment view' });
  }
};

const getUserProfile = async (req: any, res: any) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user?.uid;

    const profileDoc = await db.collection('userProfiles').doc(userId).get();

    if (!profileDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const profileData = profileDoc.data();

    // Check if current user follows this user
    let isFollowing = false;
    if (currentUserId && currentUserId !== userId) {
      const followDoc = await db
        .collection('follows')
        .where('followerId', '==', currentUserId)
        .where('followingId', '==', userId)
        .limit(1)
        .get();
      isFollowing = !followDoc.empty;
    }

    res.json({
      success: true,
      profile: {
        userId,
        ...profileData,
        isFollowing,
      },
    });
  } catch (error: any) {
    console.error('Get user profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

const getUserPosts = async (req: any, res: any) => {
  try {
    const { userId } = req.params;
    const { limit = 20 } = req.query;

    const snapshot = await db
      .collection('posts')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit as string))
      .get();

    const posts = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        postId: doc.id,
        ...data,
        createdAt: data.createdAt?.toMillis() || Date.now(),
        boostExpiresAt: data.boostExpiresAt?.toMillis() || null,
      };
    });

    res.json({ success: true, posts });
  } catch (error: any) {
    console.error('Get user posts error:', error);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
};

// Update createPost to extract hashtags
const createPost = async (req: any, res: any) => {
  try {
    const userId = req.user?.uid;
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

    // Extract hashtags
    const hashtagRegex = /#[\w]+/g;
    const hashtags = (text.match(hashtagRegex) || []).map((tag: string) => tag.toLowerCase());

    // Get user info
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    const postData = {
      userId,
      userName: userData?.displayName || userData?.name || 'Anonymous',
      userAvatar: userData?.photoURL || userData?.photoUrl || null,
      text: text.trim(),
      imageUrl: imageUrl || null,
      hashtags,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      likeCount: 0,
      commentCount: 0,
      rewardCount: 0,
      rewardPointsTotal: 0,
      viewCount: 0,
      isBoosted: false,
      boostExpiresAt: null,
      algorithmScore: 10, // Initial score for new posts
    };

    const postRef = await db.collection('posts').add(postData);

    // Update user post count
    await db.collection('userProfiles').doc(userId).update({
      postCount: admin.firestore.FieldValue.increment(1),
    });

    res.status(201).json({
      success: true,
      postId: postRef.id,
      post: { ...postData, postId: postRef.id, createdAt: Date.now() },
    });
  } catch (error: any) {
    console.error('Create post error:', error);
    res.status(500).json({ error: 'Failed to create post' });
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
  incrementPostView,
  getUserProfile,
  getUserPosts,
};