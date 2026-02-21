// backend/controllers/reportController.ts

import admin from 'firebase-admin';

const db = admin.firestore();

const REPORT_REASONS = [
  'inappropriate',
  'harassment',
  'spam',
  'religious',
  'other',
] as const;

const reportPost = async (req: any, res: any) => {
  try {
    const reporterId = req.user?.uid;
    const { postId, reason, details } = req.body;

    if (!reporterId || !postId || !reason) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!REPORT_REASONS.includes(reason)) {
      return res.status(400).json({ error: 'Invalid report reason' });
    }

    // Check if post exists
    const postDoc = await db.collection('posts').doc(postId).get();
    if (!postDoc.exists) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check if user already reported this post
    const existingReport = await db
      .collection('reports')
      .where('postId', '==', postId)
      .where('reporterId', '==', reporterId)
      .limit(1)
      .get();

    if (!existingReport.empty) {
      return res.status(400).json({ error: 'You have already reported this post' });
    }

    // Get reporter info
    const reporterDoc = await db.collection('users').doc(reporterId).get();
    const reporterData = reporterDoc.data();

    // Create report
    const reportRef = db.collection('reports').doc();
    await reportRef.set({
      reportId: reportRef.id,
      postId,
      postOwnerId: postDoc.data()?.userId,
      reporterId,
      reporterName: reporterData?.displayName || reporterData?.name || 'Anonymous',
      reason,
      details: details || '',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null,
      action: null,
    });

    res.status(201).json({
      success: true,
      reportId: reportRef.id,
      message: 'Report submitted successfully',
    });
  } catch (error: any) {
    console.error('Report post error:', error);
    res.status(500).json({ error: 'Failed to submit report', message: error.message });
  }
};

const getReports = async (req: any, res: any) => {
  try {
    const { status = 'pending', limit = 50 } = req.query;

    let query = db
      .collection('reports')
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit as string));

    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    const snapshot = await query.get();

    const reports = snapshot.docs.map((doc) => ({
      ...doc.data(),
      createdAt: doc.data().createdAt?.toMillis() || Date.now(),
      reviewedAt: doc.data().reviewedAt?.toMillis() || null,
    }));

    res.json({ success: true, reports });
  } catch (error: any) {
    console.error('Get reports error:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
};

const reviewReport = async (req: any, res: any) => {
  try {
    const adminId = req.user?.uid;
    const { reportId, action, deletePost } = req.body;

    // TODO: Add admin role check here
    // if (!isAdmin(adminId)) return res.status(403).json({ error: 'Unauthorized' });

    if (!reportId || !action) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const reportRef = db.collection('reports').doc(reportId);
    const reportDoc = await reportRef.get();

    if (!reportDoc.exists) {
      return res.status(404).json({ error: 'Report not found' });
    }

    await reportRef.update({
      status: 'reviewed',
      action,
      reviewedBy: adminId,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // If admin decides to delete the post
    if (deletePost && reportDoc.data()?.postId) {
      const postId = reportDoc.data()!.postId;
      await db.collection('posts').doc(postId).delete();
    }

    res.json({ success: true, message: 'Report reviewed successfully' });
  } catch (error: any) {
    console.error('Review report error:', error);
    res.status(500).json({ error: 'Failed to review report' });
  }
};

export default {
  reportPost,
  getReports,
  reviewReport,
};