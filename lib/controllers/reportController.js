"use strict";
// backend/controllers/reportController.ts
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
const REPORT_REASONS = [
    'inappropriate',
    'harassment',
    'spam',
    'religious',
    'other',
];
const reportPost = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    try {
        const reporterId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const { postId, reason, details } = req.body;
        if (!reporterId || !postId || !reason) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!REPORT_REASONS.includes(reason)) {
            return res.status(400).json({ error: 'Invalid report reason' });
        }
        // Check if post exists
        const postDoc = yield db.collection('posts').doc(postId).get();
        if (!postDoc.exists) {
            return res.status(404).json({ error: 'Post not found' });
        }
        // Check if user already reported this post
        const existingReport = yield db
            .collection('reports')
            .where('postId', '==', postId)
            .where('reporterId', '==', reporterId)
            .limit(1)
            .get();
        if (!existingReport.empty) {
            return res.status(400).json({ error: 'You have already reported this post' });
        }
        // Get reporter info
        const reporterDoc = yield db.collection('users').doc(reporterId).get();
        const reporterData = reporterDoc.data();
        // Create report
        const reportRef = db.collection('reports').doc();
        yield reportRef.set({
            reportId: reportRef.id,
            postId,
            postOwnerId: (_b = postDoc.data()) === null || _b === void 0 ? void 0 : _b.userId,
            reporterId,
            reporterName: (reporterData === null || reporterData === void 0 ? void 0 : reporterData.displayName) || (reporterData === null || reporterData === void 0 ? void 0 : reporterData.name) || 'Anonymous',
            reason,
            details: details || '',
            status: 'pending',
            createdAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            reviewedAt: null,
            reviewedBy: null,
            action: null,
        });
        res.status(201).json({
            success: true,
            reportId: reportRef.id,
            message: 'Report submitted successfully',
        });
    }
    catch (error) {
        console.error('Report post error:', error);
        res.status(500).json({ error: 'Failed to submit report', message: error.message });
    }
});
const getReports = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { status = 'pending', limit = 50 } = req.query;
        let query = db
            .collection('reports')
            .orderBy('createdAt', 'desc')
            .limit(parseInt(limit));
        if (status && status !== 'all') {
            query = query.where('status', '==', status);
        }
        const snapshot = yield query.get();
        const reports = snapshot.docs.map((doc) => {
            var _a, _b;
            return (Object.assign(Object.assign({}, doc.data()), { createdAt: ((_a = doc.data().createdAt) === null || _a === void 0 ? void 0 : _a.toMillis()) || Date.now(), reviewedAt: ((_b = doc.data().reviewedAt) === null || _b === void 0 ? void 0 : _b.toMillis()) || null }));
        });
        res.json({ success: true, reports });
    }
    catch (error) {
        console.error('Get reports error:', error);
        res.status(500).json({ error: 'Failed to fetch reports' });
    }
});
const reviewReport = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    try {
        const adminId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const { reportId, action, deletePost } = req.body;
        // TODO: Add admin role check here
        // if (!isAdmin(adminId)) return res.status(403).json({ error: 'Unauthorized' });
        if (!reportId || !action) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const reportRef = db.collection('reports').doc(reportId);
        const reportDoc = yield reportRef.get();
        if (!reportDoc.exists) {
            return res.status(404).json({ error: 'Report not found' });
        }
        yield reportRef.update({
            status: 'reviewed',
            action,
            reviewedBy: adminId,
            reviewedAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
        });
        // If admin decides to delete the post
        if (deletePost && ((_b = reportDoc.data()) === null || _b === void 0 ? void 0 : _b.postId)) {
            const postId = reportDoc.data().postId;
            yield db.collection('posts').doc(postId).delete();
        }
        res.json({ success: true, message: 'Report reviewed successfully' });
    }
    catch (error) {
        console.error('Review report error:', error);
        res.status(500).json({ error: 'Failed to review report' });
    }
});
exports.default = {
    reportPost,
    getReports,
    reviewReport,
};
