import { Router } from "express";
import { uploadPostImage } from "../controllers/uploadPostImage.controller";
import { authMiddleware } from "../../../middleware/auth";
import badgeController from "../controllers/badgeController";
import downloadController from "../controllers/downloadController";
import reportController from "../controllers/reportController";
import repostController from "../controllers/repostController";
import rewardController from "../controllers/rewardController";
import socialController from "../controllers/socialController";
import viewController from "../controllers/viewController";
import multer from "multer";


const  upload = multer({ storage: multer.memoryStorage(), 
  limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit


const router = Router();

// Social Feed routes
router.post('/social/posts', authMiddleware, socialController.createPost);
router.get('/social/feed', authMiddleware, socialController.getFeed);
router.post('/social/like', authMiddleware, socialController.likePost);
router.post('/social/comment', authMiddleware, socialController.commentOnPost);
router.get('/social/posts/:postId/comments', authMiddleware, socialController.getComments);
router.get('/social/leaderboard', authMiddleware, socialController.getTopEarners);
router.post('/social/upload', authMiddleware, upload.single('image'), uploadPostImage);

// backend/index.ts - ADD THIS ROUTE
router.post('/social/likes/check', authMiddleware, socialController.checkLikeStatus);

// backend/index.ts - ADD THIS ROUTE
router.delete('/social/posts/:postId', authMiddleware, socialController.deletePost);

// Reward routes
router.post('/rewards/reward', authMiddleware, rewardController.rewardPost);
router.post('/rewards/convert', authMiddleware, rewardController.convertRewardPoints);
router.post('/rewards/boost', authMiddleware, rewardController.boostPost);
router.get('/rewards/stats', authMiddleware, rewardController.getCreatorStats);

// Add these new routes to your existing index.ts

// Feed routes
router.get('/social/feed/foryou', authMiddleware, socialController.getForYouFeed);
router.get('/social/feed/following', authMiddleware, socialController.getFollowingFeed);
router.post('/social/posts/:postId/view', authMiddleware, viewController.incrementView);

// Follow routes
router.post('/social/follow', authMiddleware, socialController.followUser);
router.post('/social/unfollow', authMiddleware, socialController.unfollowUser);

// Profile routes
router.get('/social/profile/:userId', authMiddleware, socialController.getUserProfile);
router.get('/social/profile/:userId/posts', authMiddleware, socialController.getUserPosts);
// backend/index.ts - ADD THIS ROUTE

router.get('/social/posts/saved', authMiddleware, socialController.getSavedPosts);

// View routes
router.post('/social/posts/view', authMiddleware, viewController.incrementView);

// Report routes
router.post('/social/reports', authMiddleware, reportController.reportPost);
router.get('/social/reports', authMiddleware, reportController.getReports);
router.post('/social/reports/review', authMiddleware, reportController.reviewReport);

// Repost routes
router.post('/social/repost', authMiddleware, repostController.repostPost);
router.get('/social/posts/:postId/reposts', repostController.getRepostCount);

// Download routes
router.post('/social/posts/download', authMiddleware, downloadController.generatePostDownload);

// Badge routes
router.post('/admin/badges/award', authMiddleware, badgeController.awardBadge);
router.post('/admin/badges/revoke', authMiddleware, badgeController.revokeBadge);
router.get('/social/users/:userId/badges', badgeController.getUserBadges);

export default router;