// backend/controllers/viewController.ts

import admin from 'firebase-admin';
import { updatePostScore } from '../utils/algorithmService';

const db = admin.firestore();

const incrementView = async (req: any, res: any) => {
  try {
    const viewerId = req.user?.uid;
    const { postId } = req.body;

    if (!viewerId || !postId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const postRef = db.collection('posts').doc(postId);
    const postDoc = await postRef.get();

    if (!postDoc.exists) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const postData = postDoc.data();

    // Don't count owner's views
    if (postData?.userId === viewerId) {
      return res.json({ success: true, counted: false, reason: 'own_post' });
    }

    const viewerRef = db
      .collection('postViews')
      .doc(postId)
      .collection('viewers')
      .doc(viewerId);

    const viewerDoc = await viewerRef.get();
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);

    let shouldCount = false;

    if (!viewerDoc.exists) {
      // First view ever
      shouldCount = true;
      await viewerRef.set({
        viewerId,
        lastViewedAt: admin.firestore.FieldValue.serverTimestamp(),
        viewCount: 1,
      });
    } else {
      const lastViewed = viewerDoc.data()?.lastViewedAt?.toMillis() || 0;
      
      if (lastViewed < oneDayAgo) {
        // More than 24 hours since last view
        shouldCount = true;
        await viewerRef.update({
          lastViewedAt: admin.firestore.FieldValue.serverTimestamp(),
          viewCount: admin.firestore.FieldValue.increment(1),
        });
      }
    }

    if (shouldCount) {
      // Increment post view count
      await postRef.update({
        viewCount: admin.firestore.FieldValue.increment(1),
      });

      // Update algorithm score
      await updatePostScore(postId, db);

      return res.json({ success: true, counted: true });
    }

    return res.json({ success: true, counted: false, reason: 'recently_viewed' });
  } catch (error: any) {
    console.error('Increment view error:', error);
    res.status(500).json({ error: 'Failed to increment view', message: error.message });
  }
};

export default {
  incrementView,
};