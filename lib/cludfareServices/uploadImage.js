"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadPostImage = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const sharp_1 = __importDefault(require("sharp"));
const uuid_1 = require("uuid");
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
const auth_1 = require("../webhook/utils/auth");
dotenv_1.default.config();
// Initialize S3 client once
const s3Client = new client_s3_1.S3Client({
    region: "auto",
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
        secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
    },
});
const BUCKET_NAME = process.env.CLOUDFLARE_BUCKET_NAME;
const PUBLIC_URL = process.env.CLOUDFLARE_PUBLIC_URL;
// Your simple upload function - JUST LIKE YOUR createPost!
const uploadPostImage = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // Check auth first (just like your createPost)
        const userId = yield (0, auth_1.checkAuth)(req);
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
            imageBuffer = yield (0, sharp_1.default)(req.file.buffer)
                .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();
        }
        catch (compressError) {
            console.log('Compression failed, using original:', compressError);
            // Continue with original buffer
        }
        // Generate filename (just like your Firebase code!)
        const extension = path_1.default.extname(req.file.originalname) || '.jpg';
        const fileName = `posts/${userId}/${(0, uuid_1.v4)()}${extension}`;
        // Upload to Cloudflare
        const uploadCommand = new client_s3_1.PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: fileName,
            Body: imageBuffer,
            ContentType: `image/${extension.replace('.', '')}`,
        });
        yield s3Client.send(uploadCommand);
        // Return the URL (just like Firebase did!)
        const imageUrl = `https://${PUBLIC_URL}/${fileName}`;
        res.status(200).json({
            success: true,
            url: imageUrl, // Same format as your Firebase function returned
            message: 'Image uploaded successfully'
        });
    }
    catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({
            error: 'Failed to upload image',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});
exports.uploadPostImage = uploadPostImage;
