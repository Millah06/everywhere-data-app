// backend/controllers/giftController.ts

import { prisma } from "../../../prisma";
import { deductWallet, creditWallet, getWalletBalance } from "../../../shared/helpers/wallet.helpers";

const DAILY_GIFT_LIMIT_NAIRA = 50000; // ₦50,000 daily limit
const PLATFORM_FEE_PERCENT = 0.05; // 5%

// Gift types with their coin values
const GIFT_TYPES = {
  rose: { coins: 10, emoji: "🌹", name: "Rose" },
  coffee: { coins: 20, emoji: "☕", name: "Coffee" },
  fire: { coins: 50, emoji: "🔥", name: "Fire" },
  diamond: { coins: 100, emoji: "💎", name: "Diamond" },
  rocket: { coins: 500, emoji: "🚀", name: "Rocket" },
  crown: { coins: 1000, emoji: "👑", name: "Crown" },
} as const;

type GiftType = keyof typeof GIFT_TYPES;

// Convert naira to coins (₦1 = 10 coins)
const nairaToCoins = (naira: number): number => Math.floor(naira * 10);
const coinsToNaira = (coins: number): number => coins / 10;

const sendGift = async (req: any, res: any) => {
  const senderId = req.user?.id;
  const { postId, giftType } = req.body;

  console.log("=== SEND GIFT START ===");
  console.log("Sender:", senderId);
  console.log("Post:", postId);
  console.log("Gift Type:", giftType);

  try {
    if (!senderId || !postId || !giftType) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!GIFT_TYPES[giftType as GiftType]) {
      return res.status(400).json({ error: "Invalid gift type" });
    }

    const gift = GIFT_TYPES[giftType as GiftType];
    const coinAmount = gift.coins;
    const nairaEquivalent = coinsToNaira(coinAmount);
    const platformFee = nairaEquivalent * PLATFORM_FEE_PERCENT;
    const coinsAwarded = nairaToCoins(nairaEquivalent - platformFee);

    console.log(`Gift: ${gift.name} (${coinAmount} coins = ₦${nairaEquivalent})`);

    // Get post
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { userId: true },
    });

    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const receiverId = post.userId;

    if (senderId === receiverId) {
      return res.status(400).json({ error: "Cannot gift your own post" });
    }

    // Check daily limit
    const today = new Date().toISOString().split("T")[0];
    const dailyLimit = await prisma.userDailyLimit.findUnique({
      where: { userId_date: { userId: senderId, date: today } },
    });

    if (dailyLimit && dailyLimit.totalSpent >= DAILY_GIFT_LIMIT_NAIRA) {
      return res.status(400).json({
        error: `Daily gift limit of ₦${DAILY_GIFT_LIMIT_NAIRA.toLocaleString()} reached`,
      });
    }

    // Get or create sender's coin balance
    let senderCoins = await prisma.userCoins.findUnique({
      where: { userId: senderId },
    });

    if (!senderCoins) {
      senderCoins = await prisma.userCoins.create({
        data: { userId: senderId },
      });
    }

    // Auto-convert if insufficient coins
    if (senderCoins.balance < coinAmount) {
      const coinsNeeded = coinAmount - senderCoins.balance;
      const nairaNeeded = coinsToNaira(coinsNeeded);

      console.log(`Insufficient coins. Need ${coinsNeeded} more (₦${nairaNeeded})`);

      // Check wallet balance
      const walletBalance = await getWalletBalance(senderId);
      if (walletBalance < nairaNeeded) {
        return res.status(400).json({
          error: "Insufficient funds",
          coinsNeeded,
          nairaNeeded,
          walletBalance,
        });
      }

      // Auto-convert naira → coins
      console.log(`Auto-converting ₦${nairaNeeded} → ${coinsNeeded} coins`);
      await deductWallet(senderId, nairaNeeded);
      
      await prisma.userCoins.update({
        where: { userId: senderId },
        data: { balance: { increment: coinsNeeded } },
      });

      senderCoins.balance += coinsNeeded;
    }

    // Use Prisma transaction for atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Deduct coins from sender
      await tx.userCoins.update({
        where: { userId: senderId },
        data: {
          balance: { decrement: coinAmount },
          totalSpent: { increment: coinAmount },
        },
      });

      // Award coins to receiver
      await tx.userCoins.upsert({
        where: { userId: receiverId },
        create: {
          userId: receiverId,
          balance: coinsAwarded,
          totalEarned: coinsAwarded,
        },
        update: {
          balance: { increment: coinsAwarded },
          totalEarned: { increment: coinsAwarded },
        },
      });

      // Update creator stats
      await tx.creatorStats.upsert({
        where: { userId: receiverId },
        create: {
          userId: receiverId,
          totalCoinsEarned: coinsAwarded,
          totalGiftsReceived: 1,
          weeklyCoins: coinsAwarded,
          weeklyResetAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        update: {
          totalCoinsEarned: { increment: coinsAwarded },
          totalGiftsReceived: { increment: 1 },
          weeklyCoins: { increment: coinsAwarded },
          lastUpdated: new Date(),
        },
      });

      // Update post
      await tx.post.update({
        where: { id: postId },
        data: {
          giftCount: { increment: 1 },
          coinTotal: { increment: coinsAwarded },
        },
      });

      // Create gift transaction record
      const giftTx = await tx.giftTransaction.create({
        data: {
          senderId,
          receiverId,
          postId,
          giftType,
          coinAmount,
          nairaEquivalent,
          platformFee,
          coinsAwarded,
        },
      });

      // Update daily limit
      await tx.userDailyLimit.upsert({
        where: { userId_date: { userId: senderId, date: today } },
        create: {
          userId: senderId,
          date: today,
          totalSpent: nairaEquivalent,
          giftCount: 1,
          lastGiftAt: new Date(),
        },
        update: {
          totalSpent: { increment: nairaEquivalent },
          giftCount: { increment: 1 },
          lastGiftAt: new Date(),
        },
      });

      return giftTx;
    });

    console.log("=== GIFT SENT SUCCESSFULLY ===");

    res.json({
      success: true,
      giftType: gift.name,
      giftEmoji: gift.emoji,
      coinsSent: coinAmount,
      coinsAwarded,
      platformFee,
    });
  } catch (error: any) {
    console.error("=== SEND GIFT ERROR ===", error);
    res.status(500).json({ error: "Failed to send gift", message: error.message });
  }
};

const convertCoinsToNaira = async (req: any, res: any) => {
  const userId = req.user?.id;
  const { coinAmount } = req.body;

  console.log("=== CONVERT COINS START ===");
  console.log("User:", userId);
  console.log("Coins:", coinAmount);

  try {
    if (!userId || !coinAmount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const MIN_CONVERSION = 100; // Minimum 100 coins (₦10)
    if (coinAmount < MIN_CONVERSION) {
      return res.status(400).json({
        error: `Minimum conversion is ${MIN_CONVERSION} coins`,
      });
    }

    const userCoins = await prisma.userCoins.findUnique({
      where: { userId },
    });

    if (!userCoins || userCoins.balance < coinAmount) {
      return res.status(400).json({
        error: "Insufficient coins",
        available: userCoins?.balance || 0,
      });
    }

    const nairaAmount = coinsToNaira(coinAmount);

    await prisma.$transaction(async (tx) => {
      // Deduct coins
      await tx.userCoins.update({
        where: { userId },
        data: { balance: { decrement: coinAmount } },
      });

      // Credit wallet
      await creditWallet(userId, nairaAmount);

      // Update creator stats
      await tx.creatorStats.update({
        where: { userId },
        data: {
          totalNairaEarned: { increment: nairaAmount },
          lastUpdated: new Date(),
        },
      });

      // Log conversion
      await tx.coinConversion.create({
        data: {
          userId,
          coinAmount,
          nairaAmount,
        },
      });
    });

    console.log("=== CONVERSION SUCCESS ===");

    res.json({
      success: true,
      coinsConverted: coinAmount,
      nairaReceived: nairaAmount,
      message: `₦${nairaAmount.toLocaleString()} added to your wallet`,
    });
  } catch (error: any) {
    console.error("=== CONVERSION ERROR ===", error);
    res.status(500).json({ error: "Failed to convert coins" });
  }
};

const getUserCoinBalance = async (req: any, res: any) => {
  const userId = req.user?.id;

  try {
    const coins = await prisma.userCoins.findUnique({
      where: { userId },
    });

    res.json({
      success: true,
      balance: coins?.balance || 0,
      totalEarned: coins?.totalEarned || 0,
      totalSpent: coins?.totalSpent || 0,
    });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch coin balance" });
  }
};

const getCreatorStats = async (req: any, res: any) => {
  const userId = req.user?.id;

  try {
    const stats = await prisma.creatorStats.findUnique({
      where: { userId },
    });

    if (!stats) {
      return res.json({
        success: true,
        stats: {
          totalCoinsEarned: 0,
          totalNairaEarned: 0,
          totalGiftsReceived: 0,
          weeklyCoins: 0,
          level: 1,
        },
      });
    }

    res.json({
      success: true,
      stats: {
        totalCoinsEarned: stats.totalCoinsEarned,
        totalNairaEarned: stats.totalNairaEarned,
        totalGiftsReceived: stats.totalGiftsReceived,
        weeklyCoins: stats.weeklyCoins,
        level: stats.level,
        isKycVerified: stats.isKycVerified,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch creator stats" });
  }
};

export default {
  sendGift,
  convertCoinsToNaira,
  getUserCoinBalance,
  getCreatorStats,
};