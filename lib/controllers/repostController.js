"use strict";
// backend/controllers/repostController.ts
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
const db = firebase_admin_1.default.firestore();
const repostPost = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const reposterId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const { postId, text } = req.body;
        if (!reposterId || !postId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        // Get original post
        const originalPostDoc = yield db.collection('posts').doc(postId).get();
        if (!originalPostDoc.exists) {
            return res.status(404).json({ error: 'Original post not found' });
        }
        const originalPost = originalPostDoc.data();
        // Check if already reposted
        const existingRepost = yield db
            .collection('reposts')
            .where('originalPostId', '==', postId)
            .where('reposterId', '==', reposterId)
            .limit(1)
            .get();
        if (!existingRepost.empty) {
            return res.status(400).json({ error: 'You have already reposted this' });
        }
        // Get reposter info
        const reposterDoc = yield db.collection('users').doc(reposterId).get();
        const reposterData = reposterDoc.data();
        // Create repost (new post document)
        const repostRef = db.collection('posts').doc();
        const repostData = {
            userId: reposterId,
            userName: (reposterData === null || reposterData === void 0 ? void 0 : reposterData.displayName) || (reposterData === null || reposterData === void 0 ? void 0 : reposterData.name) || 'Anonymous',
            userAvatar: (reposterData === null || reposterData === void 0 ? void 0 : reposterData.photoURL) || (reposterData === null || reposterData === void 0 ? void 0 : reposterData.photoUrl) || null,
            text: text || (originalPost === null || originalPost === void 0 ? void 0 : originalPost.text) || '',
            imageUrl: (originalPost === null || originalPost === void 0 ? void 0 : originalPost.imageUrl) || null, // Reuse original image
            hashtags: (originalPost === null || originalPost === void 0 ? void 0 : originalPost.hashtags) || [],
            createdAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            likeCount: 0,
            commentCount: 0,
            viewCount: 0,
            rewardCount: 0,
            rewardPointsTotal: 0,
            isBoosted: false,
            boostExpiresAt: null,
            isRepost: true,
            originalPostId: postId,
            originalUserName: (originalPost === null || originalPost === void 0 ? void 0 : originalPost.userName) || 'Unknown',
            score: 10, // Initial score
        };
        yield repostRef.set(repostData);
        // Record repost
        yield db.collection('reposts').doc(repostRef.id).set({
            repostId: repostRef.id,
            originalPostId: postId,
            reposterId,
            createdAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
        });
        // Update reposter's repost count
        yield db.collection('userProfiles').doc(reposterId).update({
            repostCount: firebase_admin_1.default.firestore.FieldValue.increment(1),
        });
        res.status(201).json({
            success: true,
            repostId: repostRef.id,
            post: Object.assign(Object.assign({}, repostData), { postId: repostRef.id, createdAt: Date.now() }),
        });
    }
    catch (error) {
        console.error('Repost error:', error);
        res.status(500).json({ error: 'Failed to repost', message: error.message });
    }
});
const getRepostCount = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { postId } = req.params;
        const repostSnapshot = yield db
            .collection('reposts')
            .where('originalPostId', '==', postId)
            .get();
        res.json({ success: true, count: repostSnapshot.size });
    }
    catch (error) {
        console.error('Get repost count error:', error);
        res.status(500).json({ error: 'Failed to get repost count' });
    }
});
exports.default = {
    repostPost,
    getRepostCount,
};
