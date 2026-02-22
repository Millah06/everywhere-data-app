"use strict";
// backend/controllers/downloadController.ts - UPDATED WITH SHARP
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
const firebase_admin_1 = __importDefault(require("firebase-admin"));
const sharp_1 = __importDefault(require("sharp"));
const axios_1 = __importDefault(require("axios"));
const db = firebase_admin_1.default.firestore();
const generatePostDownload = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const { postId } = req.body;
        if (!postId) {
            return res.status(400).json({ error: 'Missing postId' });
        }
        const postDoc = yield db.collection('posts').doc(postId).get();
        if (!postDoc.exists) {
            return res.status(404).json({ error: 'Post not found' });
        }
        const postData = postDoc.data();
        if (!(postData === null || postData === void 0 ? void 0 : postData.imageUrl)) {
            return res.status(400).json({ error: 'Post has no image' });
        }
        console.log('📥 Downloading image from:', postData.imageUrl);
        // Download original image
        const imageResponse = yield axios_1.default.get(postData.imageUrl, {
            responseType: 'arraybuffer',
            timeout: 10000, // 10 second timeout
        });
        const imageBuffer = Buffer.from(imageResponse.data);
        // Get image metadata
        const metadata = yield (0, sharp_1.default)(imageBuffer).metadata();
        const width = metadata.width || 1080;
        const height = metadata.height || 1080;
        console.log(`📐 Image dimensions: ${width}x${height}`);
        // Create text overlays as SVG
        const caption = postData.text.length > 100
            ? postData.text.substring(0, 100) + '...'
            : postData.text;
        const username = `@${postData.userName}`;
        const watermark = 'Everywhere';
        // Calculate text positions
        const overlayHeight = 150;
        const overlayY = height - overlayHeight;
        const padding = 20;
        const captionY = overlayY + 50;
        const usernameY = overlayY + 110;
        const watermarkY = overlayY + 120;
        // Escape XML special characters
        const escapeXml = (text) => {
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&apos;');
        };
        // Create SVG overlay with gradient and text
        const svgOverlay = `
      <svg width="${width}" height="${height}">
        <!-- Gradient overlay -->
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:rgba(0,0,0,0);stop-opacity:0" />
            <stop offset="100%" style="stop-color:rgba(0,0,0,0.8);stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect x="0" y="${overlayY}" width="${width}" height="${overlayHeight}" fill="url(#grad)" />
        
        <!-- Caption text -->
        <text x="${padding}" y="${captionY}" 
              font-family="Arial, sans-serif" 
              font-size="24" 
              font-weight="bold" 
              fill="white">${escapeXml(caption)}</text>
        
        <!-- Username -->
        <text x="${padding}" y="${usernameY}" 
              font-family="Arial, sans-serif" 
              font-size="20" 
              font-weight="bold" 
              fill="#177E85">${escapeXml(username)}</text>
        
        <!-- Watermark -->
        <text x="${width - 120}" y="${watermarkY}" 
              font-family="Arial, sans-serif" 
              font-size="16" 
              fill="rgba(255,255,255,0.7)">${escapeXml(watermark)}</text>
      </svg>
    `;
        console.log('🎨 Processing image with overlays...');
        // Composite the overlay onto the image
        const processedImageBuffer = yield (0, sharp_1.default)(imageBuffer)
            .composite([
            {
                input: Buffer.from(svgOverlay),
                top: 0,
                left: 0,
            },
        ])
            .jpeg({ quality: 90 })
            .toBuffer();
        console.log('✅ Image processed successfully');
        // Convert to base64
        const base64Image = processedImageBuffer.toString('base64');
        res.json({
            success: true,
            imageData: `data:image/jpeg;base64,${base64Image}`,
            size: processedImageBuffer.length,
        });
    }
    catch (error) {
        console.error('❌ Generate download error:', error);
        res.status(500).json({
            error: 'Failed to generate download',
            message: error.message,
            details: ((_a = error.response) === null || _a === void 0 ? void 0 : _a.data) || error.stack,
        });
    }
});
exports.default = {
    generatePostDownload,
};
