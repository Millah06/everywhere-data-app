// backend/controllers/downloadController.ts - SIMPLE FALLBACK

import admin from 'firebase-admin';

const db = admin.firestore();

const generatePostDownload = async (req: any, res: any) => {
  try {
    const { postId } = req.body;

    console.log('📥 Download request for post:', postId);

    if (!postId) {
      return res.status(400).json({ error: 'Missing postId' });
    }

    const postDoc = await db.collection('posts').doc(postId).get();

    if (!postDoc.exists) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const postData = postDoc.data();

    if (!postData?.imageUrl) {
      return res.status(400).json({ error: 'Post has no image' });
    }

    // Return image URL with metadata for client-side processing
    console.log('✅ Returning image metadata for client-side processing');
    
    res.json({
      success: true,
      imageUrl: postData.imageUrl,
      caption: postData.text || '',
      username: postData.userName || 'user',
      processOnClient: true, // Flag for Flutter to process
    });
  } catch (error: any) {
    console.error('❌ Download error:', error);
    res.status(500).json({ 
      error: 'Failed to generate download', 
      message: error.message,
    });
  }
};

export default {
  generatePostDownload,
};