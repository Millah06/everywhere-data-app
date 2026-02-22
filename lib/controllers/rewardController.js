"use strict";
// backend/controllers/rewardController.ts
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
const rewardCalculator_1 = require("../utils/rewardCalculator");
const auth_1 = require("../webhook/utils/auth");
const db = firebase_admin_1.default.firestore();
// Assume wallet helpers exist
const walletHelper_1 = require("../helpers/walletHelper");
// Assume these exist
const rewardPost = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const senderId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
    const { postId, amount } = req.body;
    console.log("=== REWARD POST START ===");
    console.log("Sender:", senderId);
    console.log("Post ID:", postId);
    console.log("Amount:", amount);
    try {
        // Validation
        if (!senderId || !postId || !amount) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        if (amount < 10 || amount > 10000) {
            return res
                .status(400)
                .json({ error: "Reward amount must be between ₦10 and ₦10,000" });
        }
        // Check daily limit (do this OUTSIDE transaction)
        const today = new Date().toISOString().split("T")[0];
        const limitRef = db
            .collection("userDailyLimits")
            .doc(`${senderId}_${today}`);
        const limitDoc = yield limitRef.get();
        const limitData = limitDoc.data();
        console.log("Daily limit check:", limitData);
        if (limitData && limitData.totalRewarded >= rewardCalculator_1.DAILY_REWARD_LIMIT) {
            return res.status(400).json({
                error: `Daily reward limit of ₦${rewardCalculator_1.DAILY_REWARD_LIMIT.toLocaleString()} reached`,
            });
        }
        // Get post (do this OUTSIDE transaction)
        const postRef = db.collection("posts").doc(postId);
        const postDoc = yield postRef.get();
        console.log("Post exists:", postDoc.exists);
        if (!postDoc.exists) {
            return res.status(404).json({ error: "Post not found" });
        }
        const postData = postDoc.data();
        const creatorId = postData === null || postData === void 0 ? void 0 : postData.userId;
        console.log("Creator ID:", creatorId);
        if (!creatorId) {
            return res.status(400).json({ error: "Invalid post data" });
        }
        if (senderId === creatorId) {
            return res.status(400).json({ error: "Cannot reward your own post" });
        }
        // Calculate reward
        const calculation = (0, rewardCalculator_1.calculateReward)(amount);
        console.log("Calculation:", calculation);
        // Now do Firestore transaction
        console.log("Starting Firestore transaction...");
        yield db.runTransaction((transaction) => __awaiter(void 0, void 0, void 0, function* () {
            // Deduct from wallet BEFORE transaction
            console.log("Deducting from wallet...");
            yield (0, walletHelper_1.deductWallet)(senderId, amount);
            console.log("Wallet deducted successfully");
            const statsRef = db.collection("creatorStats").doc(creatorId);
            // READ PHASE
            console.log("Reading creator stats...");
            const statsDoc = yield transaction.get(statsRef);
            console.log("Stats exists:", statsDoc.exists);
            // WRITE PHASE
            if (statsDoc.exists) {
                const currentStats = statsDoc.data();
                const newTotalPoints = ((currentStats === null || currentStats === void 0 ? void 0 : currentStats.totalRewardPoints) || 0) + calculation.pointsAwarded;
                const newLevel = (0, rewardCalculator_1.calculateLevel)(newTotalPoints);
                console.log("Updating existing stats. New total points:", newTotalPoints);
                transaction.update(statsRef, {
                    totalRewardPoints: firebase_admin_1.default.firestore.FieldValue.increment(calculation.pointsAwarded),
                    totalRewardsReceived: firebase_admin_1.default.firestore.FieldValue.increment(1),
                    weeklyPoints: firebase_admin_1.default.firestore.FieldValue.increment(calculation.pointsAwarded),
                    lastUpdated: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
                    level: newLevel,
                });
            }
            else {
                console.log("Creating new stats document");
                transaction.set(statsRef, {
                    userId: creatorId,
                    totalRewardPoints: calculation.pointsAwarded,
                    totalEarnedNaira: 0,
                    totalRewardsReceived: 1,
                    level: (0, rewardCalculator_1.calculateLevel)(calculation.pointsAwarded),
                    isKycVerified: false,
                    lastUpdated: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
                    weeklyPoints: calculation.pointsAwarded,
                    weeklyResetAt: firebase_admin_1.default.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
                });
            }
            // Update post
            console.log("Updating post...");
            transaction.update(postRef, {
                rewardCount: firebase_admin_1.default.firestore.FieldValue.increment(1),
                rewardPointsTotal: firebase_admin_1.default.firestore.FieldValue.increment(calculation.pointsAwarded),
            });
            // Log transaction
            console.log("Creating transaction log...");
            const txRef = db.collection("rewardTransactions").doc();
            transaction.set(txRef, {
                transactionId: txRef.id,
                senderId,
                creatorId,
                postId,
                amount: calculation.originalAmount,
                platformFee: calculation.platformFee,
                pointsAwarded: calculation.pointsAwarded,
                type: "reward",
                status: "completed",
                createdAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            });
            // Update daily limit
            console.log("Updating daily limit...");
            if (limitDoc.exists) {
                transaction.update(limitRef, {
                    totalRewarded: firebase_admin_1.default.firestore.FieldValue.increment(amount),
                    rewardCount: firebase_admin_1.default.firestore.FieldValue.increment(1),
                    lastRewardAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
                });
            }
            else {
                transaction.set(limitRef, {
                    userId: senderId,
                    date: today,
                    totalRewarded: amount,
                    rewardCount: 1,
                    lastRewardAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
                });
            }
            console.log("Transaction writes complete");
        }));
        console.log("Transaction committed successfully");
        console.log("=== REWARD POST SUCCESS ===");
        res.json({
            success: true,
            pointsAwarded: calculation.pointsAwarded,
            platformFee: calculation.platformFee,
        });
    }
    catch (error) {
        console.error("=== REWARD POST ERROR ===");
        console.error("Error:", error);
        console.error("Error message:", error.message);
        console.error("Error stack:", error.stack);
        // Try to refund if wallet was deducted
        try {
            console.log("Attempting wallet refund...");
            yield (0, walletHelper_1.creditWallet)(senderId, amount);
            console.log("Wallet refunded");
        }
        catch (refundError) {
            console.error("Failed to refund wallet:", refundError);
        }
        res.status(500).json({
            error: "Failed to reward post",
            message: error.message,
        });
    }
});
const convertRewardPoints = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // const userId = req.user?.uid;
        const { amount } = req.body; // Amount of points to convert
        const userId = yield (0, auth_1.checkAuth)(req); // Verify auth
        if (!userId || !amount) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        if (amount < rewardCalculator_1.MIN_CONVERSION_POINTS) {
            return res.status(400).json({
                error: `Minimum conversion amount is ${rewardCalculator_1.MIN_CONVERSION_POINTS} points`,
            });
        }
        const statsRef = db.collection("creatorStats").doc(userId);
        const statsDoc = yield statsRef.get();
        if (!statsDoc.exists) {
            return res.status(404).json({ error: "Creator stats not found" });
        }
        const stats = statsDoc.data();
        if (!(stats === null || stats === void 0 ? void 0 : stats.isKycVerified)) {
            return res.status(403).json({
                error: "KYC verification required to convert reward points",
            });
        }
        if (stats.totalRewardPoints < amount) {
            return res.status(400).json({
                error: "Insufficient reward points",
                available: stats.totalRewardPoints,
            });
        }
        // Execute conversion
        yield db.runTransaction((transaction) => __awaiter(void 0, void 0, void 0, function* () {
            // Deduct points
            transaction.update(statsRef, {
                totalRewardPoints: firebase_admin_1.default.firestore.FieldValue.increment(-amount),
                totalEarnedNaira: firebase_admin_1.default.firestore.FieldValue.increment(amount),
                lastUpdated: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            });
            // Credit wallet
            yield (0, walletHelper_1.creditWallet)(userId, amount);
            // Log transaction
            const transactionRef = db.collection("rewardTransactions").doc();
            transaction.set(transactionRef, {
                transactionId: transactionRef.id,
                senderId: userId,
                creatorId: userId,
                postId: null,
                amount,
                platformFee: 0,
                pointsAwarded: 0,
                type: "conversion",
                status: "completed",
                createdAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            });
        }));
        res.json({
            success: true,
            convertedAmount: amount,
            message: `₦${amount.toLocaleString()} added to your wallet`,
        });
    }
    catch (error) {
        console.error("Convert points error:", error);
        res.status(500).json({ error: "Failed to convert reward points" });
    }
});
const boostPost = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // const userId = req.user?.uid;
        const userId = yield (0, auth_1.checkAuth)(req); // Verify auth
        const { postId } = req.body;
        if (!userId || !postId) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const postRef = db.collection("posts").doc(postId);
        const postDoc = yield postRef.get();
        if (!postDoc.exists) {
            return res.status(404).json({ error: "Post not found" });
        }
        const postData = postDoc.data();
        if ((postData === null || postData === void 0 ? void 0 : postData.userId) !== userId) {
            return res.status(403).json({ error: "Can only boost your own posts" });
        }
        if (postData === null || postData === void 0 ? void 0 : postData.isBoosted) {
            return res.status(400).json({ error: "Post is already boosted" });
        }
        // Check wallet balance
        const balance = yield (0, walletHelper_1.getWalletBalance)(userId);
        if (balance < rewardCalculator_1.BOOST_COST) {
            return res.status(400).json({
                error: "Insufficient balance",
                required: rewardCalculator_1.BOOST_COST,
                available: balance,
            });
        }
        const boostExpiresAt = firebase_admin_1.default.firestore.Timestamp.fromDate(new Date(Date.now() + rewardCalculator_1.BOOST_DURATION_HOURS * 60 * 60 * 1000));
        yield db.runTransaction((transaction) => __awaiter(void 0, void 0, void 0, function* () {
            // Deduct boost cost
            yield (0, walletHelper_1.deductWallet)(userId, rewardCalculator_1.BOOST_COST);
            // Update post
            transaction.update(postRef, {
                isBoosted: true,
                boostExpiresAt,
            });
            // Log transaction
            const transactionRef = db.collection("rewardTransactions").doc();
            transaction.set(transactionRef, {
                transactionId: transactionRef.id,
                senderId: userId,
                creatorId: userId,
                postId,
                amount: rewardCalculator_1.BOOST_COST,
                platformFee: rewardCalculator_1.BOOST_COST,
                pointsAwarded: 0,
                type: "boost",
                status: "completed",
                createdAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            });
        }));
        res.json({
            success: true,
            boostExpiresAt: boostExpiresAt.toMillis(),
            message: `Post boosted for ${rewardCalculator_1.BOOST_DURATION_HOURS} hours`,
        });
    }
    catch (error) {
        console.error("Boost post error:", error);
        res.status(500).json({ error: "Failed to boost post" });
    }
});
const getCreatorStats = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    try {
        const userId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        if (!userId) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const statsDoc = yield db.collection("creatorStats").doc(userId).get();
        if (!statsDoc.exists) {
            return res.json({
                success: true,
                stats: {
                    totalRewardPoints: 0,
                    totalEarnedNaira: 0,
                    level: 1,
                    isKycVerified: false,
                    weeklyPoints: 0,
                },
            });
        }
        const stats = statsDoc.data();
        res.json({
            success: true,
            stats: {
                totalRewardPoints: (stats === null || stats === void 0 ? void 0 : stats.totalRewardPoints) || 0,
                totalEarnedNaira: (stats === null || stats === void 0 ? void 0 : stats.totalEarnedNaira) || 0,
                totalRewardsReceived: (stats === null || stats === void 0 ? void 0 : stats.totalRewardsReceived) || 0,
                level: (stats === null || stats === void 0 ? void 0 : stats.level) || 1,
                isKycVerified: (stats === null || stats === void 0 ? void 0 : stats.isKycVerified) || false,
                weeklyPoints: (stats === null || stats === void 0 ? void 0 : stats.weeklyPoints) || 0,
                lastUpdated: ((_b = stats === null || stats === void 0 ? void 0 : stats.lastUpdated) === null || _b === void 0 ? void 0 : _b.toMillis()) || Date.now(),
            },
        });
    }
    catch (error) {
        console.error("Get creator stats error:", error);
        res.status(500).json({ error: "Failed to fetch creator stats" });
    }
});
exports.default = {
    rewardPost,
    convertRewardPoints,
    boostPost,
    getCreatorStats,
};
