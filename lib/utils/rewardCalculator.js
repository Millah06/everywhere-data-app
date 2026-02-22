"use strict";
// backend/utils/rewardCalculator.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOOST_DURATION_HOURS = exports.BOOST_COST = exports.MIN_CONVERSION_POINTS = exports.DAILY_REWARD_LIMIT = exports.calculateLevel = exports.calculateReward = void 0;
const calculateReward = (amount) => {
    const feePercentage = 0.05; // 5%
    const platformFee = Math.round(amount * feePercentage * 100) / 100;
    const pointsAwarded = Math.round((amount - platformFee) * 100) / 100;
    return {
        originalAmount: amount,
        platformFee,
        pointsAwarded,
        feePercentage,
    };
};
exports.calculateReward = calculateReward;
const calculateLevel = (totalPoints) => {
    if (totalPoints < 1000)
        return 1;
    if (totalPoints < 5000)
        return 2;
    if (totalPoints < 10000)
        return 3;
    if (totalPoints < 25000)
        return 4;
    if (totalPoints < 50000)
        return 5;
    if (totalPoints < 100000)
        return 6;
    if (totalPoints < 250000)
        return 7;
    if (totalPoints < 500000)
        return 8;
    if (totalPoints < 1000000)
        return 9;
    return 10;
};
exports.calculateLevel = calculateLevel;
exports.DAILY_REWARD_LIMIT = 10000; // ₦10,000 per day
exports.MIN_CONVERSION_POINTS = 1000;
exports.BOOST_COST = 300;
exports.BOOST_DURATION_HOURS = 24;
