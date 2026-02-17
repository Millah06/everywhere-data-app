import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import dotenv from 'dotenv';
import { checkAuth } from "../webhook/utils/auth";

dotenv.config();

// Initialize S3 client once
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID!,
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY!,
  },
});

const BUCKET_NAME = process.env.CLOUDFLARE_BUCKET_NAME!;
const PUBLIC_URL = process.env.CLOUDFLARE_PUBLIC_URL!;

// Your simple upload function - JUST LIKE YOUR createPost!
export const uploadPostImage = async (req: any, res: any) => {
  try {
    // Check auth first (just like your createPost)
    const userId = await checkAuth(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check if file exists (multer adds it to req.file)
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Validate file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (req.file.size > maxSize) {
      return res.status(400).json({ error: 'Image size exceeds 10MB limit' });
    }

    // // Validate file type
    // const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    // if (!allowedTypes.includes(req.file.mimetype)) {
    //   return res.status(400).json({ error: 'Invalid file type. Only JPEG, PNG, and WebP allowed' });
    // }

    // Compress image (optional but good)
    let imageBuffer = req.file.buffer;
    try {
      imageBuffer = await sharp(req.file.buffer)
        .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch (compressError) {
      console.log('Compression failed, using original:', compressError);
      // Continue with original buffer
    }

    // Generate filename (just like your Firebase code!)
    const extension = path.extname(req.file.originalname) || '.jpg';
    const fileName = `posts/${userId}/${uuidv4()}${extension}`;

    // Upload to Cloudflare
    const uploadCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: imageBuffer,
      ContentType: `image/${extension.replace('.', '')}`,
    });

    await s3Client.send(uploadCommand);

    // Return the URL (just like Firebase did!)
    const imageUrl = `https://${PUBLIC_URL}/${fileName}`;

    res.status(200).json({
      success: true,
      url: imageUrl,  // Same format as your Firebase function returned
      message: 'Image uploaded successfully'
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Failed to upload image',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

