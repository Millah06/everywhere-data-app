// backend/controllers/downloadController.ts

import admin from 'firebase-admin';
import { createCanvas, loadImage, registerFont } from 'canvas';
import axios from 'axios';

const db = admin.firestore();

const generatePostDownload = async (req: any, res: any) => {
  try {
    const { postId } = req.body;

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

    // Download original image
    const imageResponse = await axios.get(postData.imageUrl, {
      responseType: 'arraybuffer',
    });

    const imageBuffer = Buffer.from(imageResponse.data);
    const image = await loadImage(imageBuffer);

    // Create canvas
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');

    // Draw original image
    ctx.drawImage(image, 0, 0);

    // Add gradient overlay at bottom
    const gradient = ctx.createLinearGradient(0, image.height - 150, 0, image.height);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0.8)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, image.height - 150, image.width, 150);

    // Add caption
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px Arial';
    const caption = postData.text.length > 100 
      ? postData.text.substring(0, 100) + '...' 
      : postData.text;
    ctx.fillText(caption, 20, image.height - 100);

    // Add username
    ctx.fillStyle = '#177E85';
    ctx.font = 'bold 20px Arial';
    ctx.fillText(`@${postData.userName}`, 20, image.height - 60);

    // Add watermark
    ctx.fillStyle = '#ffffff';
    ctx.font = '16px Arial';
    ctx.textAlign = 'right';
    ctx.fillText('Everywhere', image.width - 20, image.height - 30);

    // Convert to buffer
    const outputBuffer = canvas.toBuffer('image/jpeg', { quality: 0.9 });

    // Upload to Cloudflare or return base64
    // For now, return base64
    const base64Image = outputBuffer.toString('base64');

    res.json({
      success: true,
      imageData: `data:image/jpeg;base64,${base64Image}`,
    });
  } catch (error: any) {
    console.error('Generate download error:', error);
    res.status(500).json({ error: 'Failed to generate download', message: error.message });
  }
};

export default {
  generatePostDownload,
};