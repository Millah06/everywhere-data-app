// backend/controllers/rewardController.ts

import admin from "firebase-admin";
import {
  calculateReward,
  calculateLevel,
  DAILY_REWARD_LIMIT,
  MIN_CONVERSION_POINTS,
  BOOST_COST,
  BOOST_DURATION_HOURS,
} from "../utils/rewardCalculator";
import { checkAuth } from "../webhook/utils/auth";

const db = admin.firestore();

// Assume wallet helpers exist
import {
  creditWallet,
  deductWallet,
  getWalletBalance,
} from "../helpers/walletHelper";

// Assume these exist

const rewardPost = async (req: any, res: any) => {
  const senderId = req.user?.uid;
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
    const limitDoc = await limitRef.get();
    const limitData = limitDoc.data();

    console.log("Daily limit check:", limitData);

    if (limitData && limitData.totalRewarded >= DAILY_REWARD_LIMIT) {
      return res.status(400).json({
        error: `Daily reward limit of ₦${DAILY_REWARD_LIMIT.toLocaleString()} reached`,
      });
    }

    // Get post (do this OUTSIDE transaction)
    const postRef = db.collection("posts").doc(postId);
    const postDoc = await postRef.get();

    console.log("Post exists:", postDoc.exists);

    if (!postDoc.exists) {
      return res.status(404).json({ error: "Post not found" });
    }

    const postData = postDoc.data();
    const creatorId = postData?.userId;

    console.log("Creator ID:", creatorId);

    if (!creatorId) {
      return res.status(400).json({ error: "Invalid post data" });
    }

    if (senderId === creatorId) {
      return res.status(400).json({ error: "Cannot reward your own post" });
    }

    // Calculate reward
    const calculation = calculateReward(amount);
    console.log("Calculation:", calculation);

    // Now do Firestore transaction
    console.log("Starting Firestore transaction...");

    await db.runTransaction(async (transaction) => {
      // Deduct from wallet BEFORE transaction
      console.log("Deducting from wallet...");
      await deductWallet(senderId, amount);
      console.log("Wallet deducted successfully");
      
      const statsRef = db.collection("creatorStats").doc(creatorId);

      // READ PHASE
      console.log("Reading creator stats...");
      const statsDoc = await transaction.get(statsRef);
      console.log("Stats exists:", statsDoc.exists);

      // WRITE PHASE
      if (statsDoc.exists) {
        const currentStats = statsDoc.data();
        const newTotalPoints =
          (currentStats?.totalRewardPoints || 0) + calculation.pointsAwarded;
        const newLevel = calculateLevel(newTotalPoints);

        console.log(
          "Updating existing stats. New total points:",
          newTotalPoints,
        );

        transaction.update(statsRef, {
          totalRewardPoints: admin.firestore.FieldValue.increment(
            calculation.pointsAwarded,
          ),
          totalRewardsReceived: admin.firestore.FieldValue.increment(1),
          weeklyPoints: admin.firestore.FieldValue.increment(
            calculation.pointsAwarded,
          ),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
          level: newLevel,
        });
      } else {
        console.log("Creating new stats document");

        transaction.set(statsRef, {
          userId: creatorId,
          totalRewardPoints: calculation.pointsAwarded,
          totalEarnedNaira: 0,
          totalRewardsReceived: 1,
          level: calculateLevel(calculation.pointsAwarded),
          isKycVerified: false,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
          weeklyPoints: calculation.pointsAwarded,
          weeklyResetAt: admin.firestore.Timestamp.fromDate(
            new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          ),
        });
      }

      // Update post
      console.log("Updating post...");
      transaction.update(postRef, {
        rewardCount: admin.firestore.FieldValue.increment(1),
        rewardPointsTotal: admin.firestore.FieldValue.increment(
          calculation.pointsAwarded,
        ),
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
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update daily limit
      console.log("Updating daily limit...");
      if (limitDoc.exists) {
        transaction.update(limitRef, {
          totalRewarded: admin.firestore.FieldValue.increment(amount),
          rewardCount: admin.firestore.FieldValue.increment(1),
          lastRewardAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        transaction.set(limitRef, {
          userId: senderId,
          date: today,
          totalRewarded: amount,
          rewardCount: 1,
          lastRewardAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      console.log("Transaction writes complete");
    });

    console.log("Transaction committed successfully");
    console.log("=== REWARD POST SUCCESS ===");

    res.json({
      success: true,
      pointsAwarded: calculation.pointsAwarded,
      platformFee: calculation.platformFee,
    });
  } catch (error: any) {
    console.error("=== REWARD POST ERROR ===");
    console.error("Error:", error);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);

    // Try to refund if wallet was deducted
    try {
      console.log("Attempting wallet refund...");
      await creditWallet(senderId, amount);
      console.log("Wallet refunded");
    } catch (refundError) {
      console.error("Failed to refund wallet:", refundError);
    }

    res.status(500).json({
      error: "Failed to reward post",
      message: error.message,
    });
  }
};

const convertRewardPoints = async (req: any, res: any) => {
  try {
    // const userId = req.user?.uid;

    const { amount } = req.body; // Amount of points to convert

    const userId = await checkAuth(req); // Verify auth

    if (!userId || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (amount < MIN_CONVERSION_POINTS) {
      return res.status(400).json({
        error: `Minimum conversion amount is ${MIN_CONVERSION_POINTS} points`,
      });
    }

    const statsRef = db.collection("creatorStats").doc(userId);
    const statsDoc = await statsRef.get();

    if (!statsDoc.exists) {
      return res.status(404).json({ error: "Creator stats not found" });
    }

    const stats = statsDoc.data();

    if (!stats?.isKycVerified) {
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
    await db.runTransaction(async (transaction) => {
      // Deduct points
      transaction.update(statsRef, {
        totalRewardPoints: admin.firestore.FieldValue.increment(-amount),
        totalEarnedNaira: admin.firestore.FieldValue.increment(amount),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Credit wallet
      await creditWallet(userId, amount);

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
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({
      success: true,
      convertedAmount: amount,
      message: `₦${amount.toLocaleString()} added to your wallet`,
    });
  } catch (error) {
    console.error("Convert points error:", error);
    res.status(500).json({ error: "Failed to convert reward points" });
  }
};

const boostPost = async (req: any, res: any) => {
  try {
    // const userId = req.user?.uid;
    const userId = await checkAuth(req); // Verify auth
    const { postId } = req.body;

    if (!userId || !postId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const postRef = db.collection("posts").doc(postId);
    const postDoc = await postRef.get();

    if (!postDoc.exists) {
      return res.status(404).json({ error: "Post not found" });
    }

    const postData = postDoc.data();

    if (postData?.userId !== userId) {
      return res.status(403).json({ error: "Can only boost your own posts" });
    }

    if (postData?.isBoosted) {
      return res.status(400).json({ error: "Post is already boosted" });
    }

    // Check wallet balance
    const balance = await getWalletBalance(userId);
    if (balance < BOOST_COST) {
      return res.status(400).json({
        error: "Insufficient balance",
        required: BOOST_COST,
        available: balance,
      });
    }

    const boostExpiresAt = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + BOOST_DURATION_HOURS * 60 * 60 * 1000),
    );

    await db.runTransaction(async (transaction) => {
      // Deduct boost cost
      await deductWallet(userId, BOOST_COST);

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
        amount: BOOST_COST,
        platformFee: BOOST_COST,
        pointsAwarded: 0,
        type: "boost",
        status: "completed",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({
      success: true,
      boostExpiresAt: boostExpiresAt.toMillis(),
      message: `Post boosted for ${BOOST_DURATION_HOURS} hours`,
    });
  } catch (error) {
    console.error("Boost post error:", error);
    res.status(500).json({ error: "Failed to boost post" });
  }
};

const getCreatorStats = async (req: any, res: any) => {
  try {
    const userId = req.user?.uid;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const statsDoc = await db.collection("creatorStats").doc(userId).get();

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
        totalRewardPoints: stats?.totalRewardPoints || 0,
        totalEarnedNaira: stats?.totalEarnedNaira || 0,
        totalRewardsReceived: stats?.totalRewardsReceived || 0,
        level: stats?.level || 1,
        isKycVerified: stats?.isKycVerified || false,
        weeklyPoints: stats?.weeklyPoints || 0,
        lastUpdated: stats?.lastUpdated?.toMillis() || Date.now(),
      },
    });
  } catch (error) {
    console.error("Get creator stats error:", error);
    res.status(500).json({ error: "Failed to fetch creator stats" });
  }
};

export default {
  rewardPost,
  convertRewardPoints,
  boostPost,
  getCreatorStats,
};
