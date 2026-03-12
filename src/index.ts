import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer"; 
import * as admin from "firebase-admin";

// Import finance tools

import createExternalWithdrawal from "./wallet/createExternalWithdrawal";

import sendAirtimeSecure from "./utilitiesServices/airtime/sendAirtime";
import sendRechargeCard from "./utilitiesServices/airtime/airtimePin";
import buyDataSecure from "./utilitiesServices/dataPurchase/buyData";
import verifyMerchant from "./utilitiesServices/cable/verifyMerchant";
import purchaseTV from "./utilitiesServices/cable/purchaseTV";
import verifyMeter from "./utilitiesServices/electricity/verifyMeter";
import purchaseElectric from "./utilitiesServices/electricity/purchaseElectric"
import purchaseSmile from "./utilitiesServices/dataPurchase/purchaseSmile";
import jambServices from "./utilitiesServices/exams/jambServices";
// import other functions here too if needed
import createVA from "./wallet/createVa";
import paystackWebhook from "./webhook/utils/payStackWebhook";
import transactionStatus from "./wallet/transactionStaatus";
 

// Import social controllers
import socialController from "./controllers/socialController";
import rewardController from "./controllers/rewardController";
import { authMiddleware } from "./middleware/auth";
import { uploadPostImage } from "./cludfareServices/uploadImage";

import viewController from './controllers/viewController';
import reportController from './controllers/reportController';
import repostController from './controllers/repostController';
import downloadController from './controllers/downloadController';
import badgeController from './controllers/badgeController';
   

dotenv.config();

const serviceAccount = JSON.parse(
  Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON!, "base64").toString("utf8")
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const app = express();
app.use(cors({origin: true}));
app.use(express.json());
 
// Congigure multer for file uploads

const  upload = multer({ storage: multer.memoryStorage(), 
  limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit



// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Add these imports at the top of your index.ts with your other imports
// ─────────────────────────────────────────────────────────────────────────────

import vendorController from "./socialFeature/vendor/vendorController";
import branchController from "./socialFeature/branch/branchController";
import menuController from "./socialFeature/menu/menuController";
import orderController from "./socialFeature/order/orderController";
import chatController from "./chat/chatController";
import locationController from "./socialFeature/location/locationController";
import adminController from "./admin/adminController";
import uploadController from "./upload/uploadController";
import { runAutoReleaseJob } from "./escow/autoReleaseJob";
import cron from "node-cron";

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Paste these routes into your index.ts after your existing routes.
// All routes use your existing `upload` multer instance (already in your index.ts).
// All routes call checkAuth internally — no authMiddleware needed on the route.
// ─────────────────────────────────────────────────────────────────────────────

// ── VENDOR ────────────────────────────────────────────────────────────────────
// NOTE: /vendor/me and /vendor/metrics MUST come before /vendor/:id
// because Express matches routes top-to-bottom and :id would swallow "me"
app.get("/vendor/list",  authMiddleware, vendorController.getVendors);
app.get("/vendor/me", authMiddleware, vendorController.getMyVendor);
app.get("/vendor/metrics", authMiddleware, vendorController.getVendorMetrics);
app.get("/vendor/:id", authMiddleware, vendorController.getVendorById);
app.post("/vendor/apply", authMiddleware, vendorController.applyAsVendor);
app.put("/vendor/visibility", authMiddleware, vendorController.toggleVisibility);
app.post("/vendor/:id/review", authMiddleware, vendorController.addReview);
app.post("/vendor/upload/logo", upload.single("image"), uploadController.uploadVendorLogo);

// ── BRANCH ────────────────────────────────────────────────────────────────────
app.get("/branch/:branchId/menu", authMiddleware, branchController.getBranchMenu);
app.get("/branch/:branchId/delivery-zones", authMiddleware, branchController.getDeliveryZones);
app.post("/branch/add", authMiddleware, branchController.addBranch);
app.put("/branch/:branchId/update", authMiddleware, branchController.updateBranch);
app.delete("/branch/:branchId/delete", authMiddleware, branchController.deleteBranch);
app.post("/branch/:branchId/zone/add", authMiddleware, branchController.addDeliveryZone);
app.delete("/branch/zone/:zoneId/delete", authMiddleware, branchController.deleteDeliveryZone);

// ── MENU ──────────────────────────────────────────────────────────────────────
app.post("/menu/:branchId/add", menuController.addMenuItem);
app.put("/menu/:itemId/update", menuController.updateMenuItem);
app.delete("/menu/:itemId/delete", menuController.deleteMenuItem);
app.put("/menu/:itemId/toggle", menuController.toggleMenuItemAvailability);
app.post("/menu/:itemId/upload-image", upload.single("image"), uploadController.uploadMenuItemImage);

// ── ORDER ─────────────────────────────────────────────────────────────────────
// NOTE: /order/mine and /order/vendor/list MUST come before /order/:orderId
app.post("/order/place", orderController.placeOrder);
app.get("/order/mine", orderController.getMyOrders);
app.get("/order/vendor/list", orderController.getVendorOrders);
app.get("/order/:orderId", orderController.getOrderById);
app.post("/order/:orderId/confirm", orderController.confirmDelivery);
app.post("/order/:orderId/appeal", orderController.appealOrder);
app.put("/order/:orderId/status", orderController.updateOrderStatus);

// ── CHAT ──────────────────────────────────────────────────────────────────────
// Flutter listens to Firestore directly for realtime messages.
// Firestore path: orderChats/{orderId}/messages (ordered by createdAt asc)
// These HTTP endpoints handle sending and initial load only.
app.post("/chat/:orderId/send", chatController.sendMessage);
app.get("/chat/:orderId/messages", chatController.getMessages);

// ── LOCATION ──────────────────────────────────────────────────────────────────
// Used by Flutter dropdowns: state → lga → area → street (each call uses the id from previous)
app.get("/location/states", locationController.getStates);
app.get("/location/lgas/:stateId", locationController.getLgas);
app.get("/location/areas/:lgaId", locationController.getAreas);
app.get("/location/streets/:areaId", locationController.getStreets);
app.get("/location/hierarchy", locationController.getFullHierarchy);

// ── ADMIN ─────────────────────────────────────────────────────────────────────
// These routes call checkAuth internally. Add your own role check in each
// controller function when you have admin roles set up in your system.
app.get("/admin/vendor/pending", adminController.getPendingVendors);
app.post("/admin/vendor/:vendorId/approve", adminController.approveVendor);
app.post("/admin/vendor/:vendorId/reject", adminController.rejectVendor);
app.get("/admin/order/appeals", adminController.getAppeals);
app.post("/admin/order/:orderId/resolve", adminController.resolveAppeal);
app.post("/admin/chat/:orderId/send", chatController.adminSendMessage);
app.get("/admin/config", adminController.getConfig);
app.put("/admin/config", adminController.updateConfig);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Paste this AFTER your app.listen() call.
// Escrow auto-release runs every hour — releases held funds where the buyer
// did not confirm delivery within autoReleaseHours (set in AppConfig table).
// ─────────────────────────────────────────────────────────────────────────────

cron.schedule("0 * * * *", async () => {
  await runAutoReleaseJob();
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: Run this ONE TIME to seed AppConfig.
// Either run it as a script or add it temporarily after app.listen().
// transactionFeePercent is 0 at launch — update the DB row to change globally.
// ─────────────────────────────────────────────────────────────────────────────

// import { prisma } from "./lib/prisma";
// await prisma.appConfig.upsert({
//   where: { id: "singleton" },
//   update: {},
//   create: {
//     id: "singleton",
//     transactionFeePercent: 0,
//     autoReleaseHours: 24,
//     appealWindowHours: 48,
//     chatCloseHours: 72,
//     commissionPercent: 5,
//   },
// });

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5: Install the one new package needed for the cron job.
// npm install node-cron
// npm install --save-dev @types/node-cron
// ─────────────────────────────────────────────────────────────────────────────

app.get("/banks/list", createExternalWithdrawal.fetchListOfBanks);

app.get("/banks/resolve/:accountNumber/:bankCode", createExternalWithdrawal.resolveBankAccount);
app.post('/banks/initiateWithdrawal', authMiddleware, createExternalWithdrawal.createExternalWithdrawal);

app.post("/airtime/sendAirtime", sendAirtimeSecure);
app.post("/airtime/sendRecharge", sendRechargeCard);
app.post("/cable/purchaseTV", purchaseTV);
app.post("/cable/verifyMerchant", verifyMerchant);
app.post("/data/buyData", buyDataSecure);
app.post("/electricity/verifyMeter", verifyMeter);
app.post("/electricity/purchaseElectric", purchaseElectric);
app.post('/data/purchaseSmile', purchaseSmile);
app.post("/wallet/createVA", createVA);
app.post("/webhook/paystack", paystackWebhook);
app.get("/exams/jambServices", jambServices);
app.get('/transactions/status/:transactionId', transactionStatus);

// Social Feed routes
app.post('/social/posts', authMiddleware, socialController.createPost);
app.get('/social/feed', authMiddleware, socialController.getFeed);
app.post('/social/like', authMiddleware, socialController.likePost);
app.post('/social/comment', authMiddleware, socialController.commentOnPost);
app.get('/social/posts/:postId/comments', authMiddleware, socialController.getComments);
app.get('/social/leaderboard', authMiddleware, socialController.getTopEarners);
app.post('/social/upload', authMiddleware, upload.single('image'), uploadPostImage);

// backend/index.ts - ADD THIS ROUTE
app.post('/social/likes/check', authMiddleware, socialController.checkLikeStatus);

// backend/index.ts - ADD THIS ROUTE
app.delete('/social/posts/:postId', authMiddleware, socialController.deletePost);

// Reward routes
app.post('/rewards/reward', authMiddleware, rewardController.rewardPost);
app.post('/rewards/convert', authMiddleware, rewardController.convertRewardPoints);
app.post('/rewards/boost', authMiddleware, rewardController.boostPost);
app.get('/rewards/stats', authMiddleware, rewardController.getCreatorStats);

// Add these new routes to your existing index.ts

// Feed routes
app.get('/social/feed/foryou', authMiddleware, socialController.getForYouFeed);
app.get('/social/feed/following', authMiddleware, socialController.getFollowingFeed);
app.post('/social/posts/:postId/view', authMiddleware, viewController.incrementView);

// Follow routes
app.post('/social/follow', authMiddleware, socialController.followUser);
app.post('/social/unfollow', authMiddleware, socialController.unfollowUser);

// Profile routes
app.get('/social/profile/:userId', authMiddleware, socialController.getUserProfile);
app.get('/social/profile/:userId/posts', authMiddleware, socialController.getUserPosts);
// backend/index.ts - ADD THIS ROUTE

app.get('/social/posts/saved', authMiddleware, socialController.getSavedPosts);

// Add to your existing index.ts



// View routes
app.post('/social/posts/view', authMiddleware, viewController.incrementView);

// Report routes
app.post('/social/reports', authMiddleware, reportController.reportPost);
app.get('/social/reports', authMiddleware, reportController.getReports);
app.post('/social/reports/review', authMiddleware, reportController.reviewReport);

// Repost routes
app.post('/social/repost', authMiddleware, repostController.repostPost);
app.get('/social/posts/:postId/reposts', repostController.getRepostCount);

// Download routes
app.post('/social/posts/download', authMiddleware, downloadController.generatePostDownload);

// Badge routes
app.post('/admin/badges/award', authMiddleware, badgeController.awardBadge);
app.post('/admin/badges/revoke', authMiddleware, badgeController.revokeBadge);
app.get('/social/users/:userId/badges', badgeController.getUserBadges);

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});