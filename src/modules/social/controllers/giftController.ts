// src/modules/social/controllers/giftController.ts
//
// PHASE 10 — gifting + conversion + balance, on the purchased/earned split.
// FULL FILE — replace your existing giftController.ts wholesale.
//
//   sendGift            spend coins (purchased-first, then earned) → receiver gets
//                       EARNED coins. NO wallet fallback (real money never enters
//                       a gift).
//   convertCoinsToNaira EARNED coins only, NG-tied users only → wallet credit.
//   getUserCoinBalance  returns the split (purchased / earned / convertible).
//   getCreatorStats     unchanged.
//   getTopEarners       unchanged.

import { prisma } from "../../../prisma";
import { creditWallet } from "../../../shared/helpers/wallet.helpers";
import {
  getCoinRates,
  coinsToNaira,
  isNgTied,
  spendCoins,
  creditEarnedCoins,
  debitEarnedForConversion,
  getOrCreateLedger,
} from "../../../shared/helpers/coin.helpers";
import { recordRevenue } from "../../../shared/services/revenue.service";
import { bumpAffinityForEngagement } from "../services/affinity.service";
import { isKycVerified } from "../../verification/verification.service";

const DAILY_GIFT_LIMIT_NAIRA = 50000; // ₦50,000/day anti-abuse cap
const PLATFORM_FEE_PERCENT = 0.05; // 5% breakage = platform revenue

// Gift catalog — coin cost per gift. Keep in sync with the Flutter GiftType model.
// Full catalog — kept in lockstep with the Flutter source of truth
// (app: lib/features/social/models/gift_type.dart). Coins MUST match.
const GIFT_TYPES = {
  // Tier 1 — budget
  rose: { coins: 10, emoji: "🌹", name: "Rose" },
  heart: { coins: 15, emoji: "❤️", name: "Heart" },
  coffee: { coins: 20, emoji: "☕", name: "Coffee" },
  cake: { coins: 30, emoji: "🎂", name: "Cake" },
  pizza: { coins: 50, emoji: "🍕", name: "Pizza" },
  gift: { coins: 75, emoji: "🎁", name: "Gift Box" },
  star: { coins: 100, emoji: "⭐", name: "Star" },
  // Tier 2 — mid-range
  fire: { coins: 150, emoji: "🔥", name: "Fire" },
  balloon: { coins: 200, emoji: "🎈", name: "Balloon" },
  trophy: { coins: 250, emoji: "🏆", name: "Trophy" },
  champagne: { coins: 300, emoji: "🍾", name: "Champagne" },
  diamond: { coins: 500, emoji: "💎", name: "Diamond" },
  gem: { coins: 750, emoji: "💍", name: "Gem" },
  fireworks: { coins: 1000, emoji: "🎆", name: "Fireworks" },
  // Tier 3 — premium
  rocket: { coins: 1500, emoji: "🚀", name: "Rocket" },
  sports: { coins: 2000, emoji: "🏎️", name: "Sports Car" },
  airplane: { coins: 3000, emoji: "✈️", name: "Airplane" },
  yacht: { coins: 4000, emoji: "🛥️", name: "Yacht" },
  castle: { coins: 5000, emoji: "🏰", name: "Castle" },
  // Tier 4 — VIP
  crown: { coins: 7500, emoji: "👑", name: "Crown" },
  unicorn: { coins: 10000, emoji: "🦄", name: "Unicorn" },
  dragon: { coins: 15000, emoji: "🐉", name: "Dragon" },
  galaxy: { coins: 20000, emoji: "🌌", name: "Galaxy" },
} as const;
type GiftType = keyof typeof GIFT_TYPES;

// ─────────────────────────────────────────────────────────────────────────────
const sendGift = async (req: any, res: any) => {
  const senderId = req.user?.id;
  const { postId, giftType } = req.body;
  try {
    if (!senderId || !postId || !giftType) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!GIFT_TYPES[giftType as GiftType]) {
      return res.status(400).json({ error: "Invalid gift type" });
    }

    const gift = GIFT_TYPES[giftType as GiftType];
    const coinAmount = gift.coins;

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { userId: true },
    });
    if (!post) return res.status(404).json({ error: "Post not found" });
    const receiverId = post.userId;
    if (senderId === receiverId) {
      return res.status(400).json({ error: "You can't gift your own post" });
    }

    const { purchaseRateNgn } = await getCoinRates();
    const nairaEquivalent = coinsToNaira(coinAmount, purchaseRateNgn); // display + limit only
    const platformFee = nairaEquivalent * PLATFORM_FEE_PERCENT;
    const coinsAwarded = Math.floor(coinAmount * (1 - PLATFORM_FEE_PERCENT));

    // Daily anti-abuse limit (naira-equivalent).
    const today = new Date().toISOString().slice(0, 10);
    const todayLimit = await prisma.userDailyLimit.findUnique({
      where: { userId_date: { userId: senderId, date: today } },
    });
    if ((todayLimit?.totalSpent ?? 0) + nairaEquivalent > DAILY_GIFT_LIMIT_NAIRA) {
      return res.status(400).json({ error: "Daily gifting limit reached" });
    }

    let split: { fromPurchased: number; fromEarned: number } | undefined;
    try {
      await prisma.$transaction(async (tx) => {
        // Coins ONLY — purchased-first, then earned. No wallet fallback.
        split = await spendCoins(tx, senderId, coinAmount);
        // Receiver gets EARNED (convertible) coins.
        await creditEarnedCoins(tx, receiverId, coinsAwarded);

        await tx.creatorStats.upsert({
          where: { userId: receiverId },
          create: {
            userId: receiverId,
            totalCoinsEarned: coinsAwarded,
            totalGiftsReceived: 1,
            weeklyCoins: coinsAwarded,
            weeklyResetAt: new Date(Date.now() + 7 * 86400000),
          },
          update: {
            totalCoinsEarned: { increment: coinsAwarded },
            totalGiftsReceived: { increment: 1 },
            weeklyCoins: { increment: coinsAwarded },
            lastUpdated: new Date(),
          },
        });

        await tx.post.update({
          where: { id: postId },
          data: { giftCount: { increment: 1 }, coinTotal: { increment: coinsAwarded } },
        });

        const giftRow = await tx.giftTransaction.create({
          data: {
            senderId, receiverId, postId, giftType,
            coinAmount, nairaEquivalent, platformFee, coinsAwarded,
          },
        });
        // Reconciliation: the 5% gift fee is coin-economy breakage = platform
        // revenue on the COIN rail (kept out of the NGN float surplus).
        await recordRevenue(tx, {
          source: "gift_breakage",
          track: "coin",
          amount: platformFee,
          refType: "gift",
          refId: giftRow.id,
          idempotencyKey: `gift_breakage:${giftRow.id}`,
          note: "Gift platform fee (coin breakage)",
        });

        await tx.userDailyLimit.upsert({
          where: { userId_date: { userId: senderId, date: today } },
          create: { userId: senderId, date: today, totalSpent: nairaEquivalent, giftCount: 1, lastGiftAt: new Date() },
          update: { totalSpent: { increment: nairaEquivalent }, giftCount: { increment: 1 }, lastGiftAt: new Date() },
        });
      });
    } catch (e: any) {
      if (e?.code === "INSUFFICIENT_COINS") {
        return res.status(400).json({
          error: "Not enough coins", code: "INSUFFICIENT_COINS", available: e.available,
        });
      }
      throw e;
    }

    // PHASE 11: gifting is the strongest taste signal we have (real coins spent).
    void bumpAffinityForEngagement(senderId, postId, "gift");

    return res.json({
      success: true,
      giftType: gift.name,
      giftEmoji: gift.emoji,
      coinsSent: coinAmount,
      coinsAwarded,
      platformFee,
      spentFromPurchased: split?.fromPurchased ?? 0,
      spentFromEarned: split?.fromEarned ?? 0,
    });
  } catch (error: any) {
    console.error("=== SEND GIFT ERROR ===", error);
    res.status(500).json({ error: "Failed to send gift", message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
const convertCoinsToNaira = async (req: any, res: any) => {
  const userId = req.user?.id;
  const { coinAmount } = req.body;
  try {
    if (!userId || !coinAmount) return res.status(400).json({ error: "Missing required fields" });

    const MIN_CONVERSION = 100;
    if (coinAmount < MIN_CONVERSION) {
      return res.status(400).json({ error: `Minimum conversion is ${MIN_CONVERSION} coins` });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, country: true },
    });
    
    if (!user || !isNgTied(user)) {
      return res.status(403).json({
        error: "Coin conversion is available to Nigeria-tied accounts only",
        code: "REGION_BLOCKED",
      });
    }

    // Phase 13: turning earnings into cash requires verified identity (BVN/NIN).
    if (!(await isKycVerified(userId))) {
      return res.status(403).json({
        error: "Verify your identity (BVN or NIN) to cash out your earnings.",
        code: "KYC_REQUIRED",
      });
    }

    const ledger = await getOrCreateLedger(prisma, userId);
    if (ledger.earnedCoins < coinAmount) {
      return res.status(400).json({
        error: "Insufficient earned coins (only gifted coins can be converted)",
        code: "INSUFFICIENT_EARNED_COINS",
        available: ledger.earnedCoins,
      });
    }

    const { conversionRate } = await getCoinRates();
    const nairaAmount = coinsToNaira(coinAmount, conversionRate);

    await prisma.$transaction(async (tx) => {
      await debitEarnedForConversion(tx, userId, coinAmount); // never touches purchased
      await creditWallet(userId, nairaAmount);
      await tx.creatorStats.update({
        where: { userId },
        data: { totalNairaEarned: { increment: nairaAmount }, lastUpdated: new Date() },
      });
      
      await tx.coinConversion.create({ data: { userId, coinAmount, nairaAmount } });

      // Reconciliation: conversion spread (purchaseRate − conversionRate) on the
      // converted coins is coin-rail revenue. Often 0 today (rates equal) →
      // recordRevenue skips non-positive amounts.
      const { purchaseRateNgn } = await getCoinRates();
      const spread = coinAmount * purchaseRateNgn - nairaAmount;
      await recordRevenue(tx, {
        source: "conversion_spread",
        track: "coin",
        amount: spread,
        refType: "conversion",
        refId: userId,
        idempotencyKey: `conversion_spread:${userId}:${Date.now()}`,
        note: "Earned-coin cash-out spread",
      });
    });

    return res.json({
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

// ─────────────────────────────────────────────────────────────────────────────
const getUserCoinBalance = async (req: any, res: any) => {
  const userId = req.user?.id;
  try {
    const ledger = await getOrCreateLedger(prisma, userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, country: true },
    });
    const ngTied = !!user && isNgTied(user);
    res.json({
      success: true,
      balance: ledger.balance, // legacy total = purchased + earned
      purchasedCoins: ledger.purchasedCoins,
      earnedCoins: ledger.earnedCoins,
      convertibleCoins: ngTied ? ledger.earnedCoins : 0,
      canConvert: ngTied,
      totalEarned: ledger.totalEarned,
      totalSpent: ledger.totalSpent,
      totalPurchased: ledger.totalPurchased,
    });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch coin balance" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UNCHANGED below.
const getCreatorStats = async (req: any, res: any) => {
  const userId = req.user?.id;
  try {
    const stats = await prisma.creatorStats.findUnique({ where: { userId } });
    if (!stats) {
      return res.json({
        success: true,
        stats: { totalCoinsEarned: 0, totalNairaEarned: 0, totalGiftsReceived: 0, weeklyCoins: 0, level: 1 },
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

const getTopEarners = async (_req: any, res: any) => {
  try {
    const topCreators = await prisma.creatorStats.findMany({
      orderBy: { weeklyCoins: "desc" },
      take: 10,
      include: { user: { select: { name: true, userProfile: { select: { avatarUrl: true } } } } },
    });
    const earners = topCreators.map((stats) => ({
      userId: stats.userId,
      userName: stats.user.name,
      userAvatar: stats.user.userProfile?.avatarUrl,
      totalCoins: stats.totalCoinsEarned,
      weeklyCoins: stats.weeklyCoins,
      totalNaira: stats.totalNairaEarned,
      level: stats.level,
    }));
    res.json({ success: true, earners });
  } catch (error: any) {
    console.error("Get top earners error:", error);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Direct user gift — gift a PERSON, not a post. Same ledger rules as sendGift:
// spend purchased-first-then-earned, recipient gets EARNED coins, no wallet
// fallback. GiftTransaction.postId is null here (needs the nullable migration —
// see the Part 3 doc). No post counters are touched.
const sendUserGift = async (req: any, res: any) => {
  const senderId = req.user?.id;
  const { receiverId, giftType } = req.body;
  try {
    if (!senderId || !receiverId || !giftType) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!GIFT_TYPES[giftType as GiftType]) {
      return res.status(400).json({ error: "Invalid gift type" });
    }
    if (senderId === receiverId) {
      return res.status(400).json({ error: "You can't gift yourself" });
    }
    const receiver = await prisma.user.findUnique({
      where: { id: receiverId },
      select: { id: true },
    });
    if (!receiver) return res.status(404).json({ error: "Recipient not found" });

    const gift = GIFT_TYPES[giftType as GiftType];
    const coinAmount = gift.coins;
    const { purchaseRateNgn } = await getCoinRates();
    const nairaEquivalent = coinsToNaira(coinAmount, purchaseRateNgn);
    const platformFee = nairaEquivalent * PLATFORM_FEE_PERCENT;
    const coinsAwarded = Math.floor(coinAmount * (1 - PLATFORM_FEE_PERCENT));

    const today = new Date().toISOString().slice(0, 10);
    const todayLimit = await prisma.userDailyLimit.findUnique({
      where: { userId_date: { userId: senderId, date: today } },
    });
    if ((todayLimit?.totalSpent ?? 0) + nairaEquivalent > DAILY_GIFT_LIMIT_NAIRA) {
      return res.status(400).json({ error: "Daily gifting limit reached" });
    }

    let split: { fromPurchased: number; fromEarned: number } | undefined;
    try {
      await prisma.$transaction(async (tx) => {
        split = await spendCoins(tx, senderId, coinAmount);
        await creditEarnedCoins(tx, receiverId, coinsAwarded);
        await tx.creatorStats.upsert({
          where: { userId: receiverId },
          create: {
            userId: receiverId,
            totalCoinsEarned: coinsAwarded,
            totalGiftsReceived: 1,
            weeklyCoins: coinsAwarded,
            weeklyResetAt: new Date(Date.now() + 7 * 86400000),
          },
          update: {
            totalCoinsEarned: { increment: coinsAwarded },
            totalGiftsReceived: { increment: 1 },
            weeklyCoins: { increment: coinsAwarded },
            lastUpdated: new Date(),
          },
        });
        
        const giftRow = await tx.giftTransaction.create({
          data: {
            senderId, receiverId, postId: null, giftType,
            coinAmount, nairaEquivalent, platformFee, coinsAwarded,
          },
        });
        // Reconciliation: the 5% gift fee is coin-economy breakage = platform
        // revenue on the COIN rail (kept out of the NGN float surplus).
        await recordRevenue(tx, {
          source: "gift_breakage",
          track: "coin",
          amount: platformFee,
          refType: "gift",
          refId: giftRow.id,
          idempotencyKey: `gift_breakage:${giftRow.id}`,
          note: "Gift platform fee (coin breakage)",
        });

        await tx.userDailyLimit.upsert({
          where: { userId_date: { userId: senderId, date: today } },
          create: { userId: senderId, date: today, totalSpent: nairaEquivalent, giftCount: 1, lastGiftAt: new Date() },
          update: { totalSpent: { increment: nairaEquivalent }, giftCount: { increment: 1 }, lastGiftAt: new Date() },
        });
      });
    } catch (e: any) {
      if (e?.code === "INSUFFICIENT_COINS") {
        return res.status(400).json({ error: "Not enough coins", code: "INSUFFICIENT_COINS", available: e.available });
      }
      throw e;
    }

    return res.json({
      success: true,
      giftType: gift.name,
      giftEmoji: gift.emoji,
      coinsSent: coinAmount,
      coinsAwarded,
      platformFee,
      spentFromPurchased: split?.fromPurchased ?? 0,
      spentFromEarned: split?.fromEarned ?? 0,
    });
  } catch (error: any) {
    console.error("=== SEND USER GIFT ERROR ===", error);
    res.status(500).json({ error: "Failed to send gift", message: error.message });
  }
};

export default { sendGift, sendUserGift, convertCoinsToNaira, getUserCoinBalance, getCreatorStats, getTopEarners };