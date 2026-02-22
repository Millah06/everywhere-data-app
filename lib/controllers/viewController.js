"use strict";
// backend/controllers/viewController.ts
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
const algorithmService_1 = require("../utils/algorithmService");
const db = firebase_admin_1.default.firestore();
const incrementView = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    try {
        const viewerId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const { postId } = req.body;
        if (!viewerId || !postId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const postRef = db.collection('posts').doc(postId);
        const postDoc = yield postRef.get();
        if (!postDoc.exists) {
            return res.status(404).json({ error: 'Post not found' });
        }
        const postData = postDoc.data();
        // Don't count owner's views
        if ((postData === null || postData === void 0 ? void 0 : postData.userId) === viewerId) {
            return res.json({ success: true, counted: false, reason: 'own_post' });
        }
        const viewerRef = db
            .collection('postViews')
            .doc(postId)
            .collection('viewers')
            .doc(viewerId);
        const viewerDoc = yield viewerRef.get();
        const now = Date.now();
        const oneDayAgo = now - (24 * 60 * 60 * 1000);
        let shouldCount = false;
        if (!viewerDoc.exists) {
            // First view ever
            shouldCount = true;
            yield viewerRef.set({
                viewerId,
                lastViewedAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
                viewCount: 1,
            });
        }
        else {
            const lastViewed = ((_c = (_b = viewerDoc.data()) === null || _b === void 0 ? void 0 : _b.lastViewedAt) === null || _c === void 0 ? void 0 : _c.toMillis()) || 0;
            if (lastViewed < oneDayAgo) {
                // More than 24 hours since last view
                shouldCount = true;
                yield viewerRef.update({
                    lastViewedAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
                    viewCount: firebase_admin_1.default.firestore.FieldValue.increment(1),
                });
            }
        }
        if (shouldCount) {
            // Increment post view count
            yield postRef.update({
                viewCount: firebase_admin_1.default.firestore.FieldValue.increment(1),
            });
            // Update algorithm score
            yield (0, algorithmService_1.updatePostScore)(postId, db);
            return res.json({ success: true, counted: true });
        }
        return res.json({ success: true, counted: false, reason: 'recently_viewed' });
    }
    catch (error) {
        console.error('Increment view error:', error);
        res.status(500).json({ error: 'Failed to increment view', message: error.message });
    }
});
exports.default = {
    incrementView,
};
