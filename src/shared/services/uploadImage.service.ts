import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import dotenv from "dotenv";

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



export const uploadImage = async (
  file: Express.Multer.File,
  userId: String,
  fileCategory: String,
) => {
  try {
    // Check if file exists (multer adds it to req.file)
    if (!file) {
      throw new Error("No image file provided");
    }

    // Validate file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      throw new Error("Image size exceeds 10MB limit");
    }

    // // Validate file type
    // const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    // if (!allowedTypes.includes(req.file.mimetype)) {
    //   return res.status(400).json({ error: 'Invalid file type. Only JPEG, PNG, and WebP allowed' });
    // }

    // Compress image (optional but good)
    let imageBuffer = file.buffer;
    try {
      imageBuffer = await sharp(file.buffer)
        .resize(1920, 1080, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch (compressError) {
      console.log("Compression failed, using original:", compressError);
      // Continue with original buffer
    }

    // Generate filename (just like your Firebase code!)
    const extension = path.extname(file.originalname) || ".jpg";
    const fileName = `${fileCategory}/${userId}/${uuidv4()}${extension}`;

    // Upload to Cloudflare
    const uploadCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: imageBuffer,
      ContentType: `image/${extension.replace(".", "")}`,
    });

    await s3Client.send(uploadCommand);

    // Return the URL (just like Firebase did!)
    const imageUrl = `https://${PUBLIC_URL}/${fileName}`;

    return imageUrl;
  } catch (error) {
    console.error("Upload error:", error);
    throw new Error("Unexpected Error: failed to upload image ");
  }
};

export default { uploadImage };
