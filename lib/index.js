"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const multer_1 = __importDefault(require("multer"));
const admin = __importStar(require("firebase-admin"));
const sendAirtime_1 = __importDefault(require("./airtime/sendAirtime"));
const airtimePin_1 = __importDefault(require("./airtime/airtimePin"));
const buyData_1 = __importDefault(require("./data/buyData"));
const verifyMerchant_1 = __importDefault(require("./cable/verifyMerchant"));
const purchaseTV_1 = __importDefault(require("./cable/purchaseTV"));
const verifyMeter_1 = __importDefault(require("./electricity/verifyMeter"));
const purchaseElectric_1 = __importDefault(require("./electricity/purchaseElectric"));
const purchaseSmile_1 = __importDefault(require("./data/purchaseSmile"));
const jambServices_1 = __importDefault(require("./exams/jambServices"));
// import other functions here too if needed
const createVa_1 = __importDefault(require("./wallet/createVa"));
const payStackWebhook_1 = __importDefault(require("./webhook/utils/payStackWebhook"));
const transactionStaatus_1 = __importDefault(require("./wallet/transactionStaatus"));
// Import social controllers
const socialController_1 = __importDefault(require("./controllers/socialController"));
const rewardController_1 = __importDefault(require("./controllers/rewardController"));
const auth_1 = require("./middleware/auth");
const uploadImage_1 = require("./cludfareServices/uploadImage");
const viewController_1 = __importDefault(require("./controllers/viewController"));
const reportController_1 = __importDefault(require("./controllers/reportController"));
const repostController_1 = __importDefault(require("./controllers/repostController"));
const downloadController_1 = __importDefault(require("./controllers/downloadController"));
const badgeController_1 = __importDefault(require("./controllers/badgeController"));
dotenv_1.default.config();
const serviceAccount = JSON.parse(Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, "base64").toString("utf8"));
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: true }));
app.use(express_1.default.json());
// Congigure multer for file uploads
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit
app.post("/airtime/sendAirtime", sendAirtime_1.default);
app.post("/airtime/sendRecharge", airtimePin_1.default);
app.post("/cable/purchaseTV", purchaseTV_1.default);
app.post("/cable/verifyMerchant", verifyMerchant_1.default);
app.post("/data/buyData", buyData_1.default);
app.post("/electricity/verifyMeter", verifyMeter_1.default);
app.post("/electricity/purchaseElectric", purchaseElectric_1.default);
app.post('/data/purchaseSmile', purchaseSmile_1.default);
app.post("/wallet/createVA", createVa_1.default);
app.post("/webhook/paystack", payStackWebhook_1.default);
app.get("/exams/jambServices", jambServices_1.default);
app.get('/transactions/status/:transactionId', transactionStaatus_1.default);
// Social Feed routes
app.post('/social/posts', auth_1.authMiddleware, socialController_1.default.createPost);
app.get('/social/feed', auth_1.authMiddleware, socialController_1.default.getFeed);
app.post('/social/like', auth_1.authMiddleware, socialController_1.default.likePost);
app.post('/social/comment', auth_1.authMiddleware, socialController_1.default.commentOnPost);
app.get('/social/posts/:postId/comments', auth_1.authMiddleware, socialController_1.default.getComments);
app.get('/social/leaderboard', auth_1.authMiddleware, socialController_1.default.getTopEarners);
app.post('/social/upload', auth_1.authMiddleware, upload.single('image'), uploadImage_1.uploadPostImage);
// Reward routes
app.post('/rewards/reward', auth_1.authMiddleware, rewardController_1.default.rewardPost);
app.post('/rewards/convert', auth_1.authMiddleware, rewardController_1.default.convertRewardPoints);
app.post('/rewards/boost', auth_1.authMiddleware, rewardController_1.default.boostPost);
app.get('/rewards/stats', auth_1.authMiddleware, rewardController_1.default.getCreatorStats);
// Add these new routes to your existing index.ts
// Feed routes
app.get('/social/feed/foryou', auth_1.authMiddleware, socialController_1.default.getForYouFeed);
app.get('/social/feed/following', auth_1.authMiddleware, socialController_1.default.getFollowingFeed);
app.post('/social/posts/:postId/view', auth_1.authMiddleware, viewController_1.default.incrementView);
// Follow routes
app.post('/social/follow', auth_1.authMiddleware, socialController_1.default.followUser);
app.post('/social/unfollow', auth_1.authMiddleware, socialController_1.default.unfollowUser);
// Profile routes
app.get('/social/profile/:userId', auth_1.authMiddleware, socialController_1.default.getUserProfile);
app.get('/social/profile/:userId/posts', auth_1.authMiddleware, socialController_1.default.getUserPosts);
// Add to your existing index.ts
// View routes
app.post('/social/posts/view', auth_1.authMiddleware, viewController_1.default.incrementView);
// Report routes
app.post('/social/reports', auth_1.authMiddleware, reportController_1.default.reportPost);
app.get('/social/reports', auth_1.authMiddleware, reportController_1.default.getReports);
app.post('/social/reports/review', auth_1.authMiddleware, reportController_1.default.reviewReport);
// Repost routes
app.post('/social/repost', auth_1.authMiddleware, repostController_1.default.repostPost);
app.get('/social/posts/:postId/reposts', repostController_1.default.getRepostCount);
// Download routes
app.post('/social/posts/download', auth_1.authMiddleware, downloadController_1.default.generatePostDownload);
// Badge routes
app.post('/admin/badges/award', auth_1.authMiddleware, badgeController_1.default.awardBadge);
app.post('/admin/badges/revoke', auth_1.authMiddleware, badgeController_1.default.revokeBadge);
app.get('/social/users/:userId/badges', badgeController_1.default.getUserBadges);
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
