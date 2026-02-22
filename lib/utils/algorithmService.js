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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updatePostScore = exports.calculateAlgorithmScore = void 0;
// backend/utils/algorithmService.ts
const admin = __importStar(require("firebase-admin"));
const calculateAlgorithmScore = (postData, db) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    const now = Date.now();
    const postTime = ((_a = postData.createdAt) === null || _a === void 0 ? void 0 : _a.toMillis()) || now;
    const ageInHours = (now - postTime) / (1000 * 60 * 60);
    // Recency weight
    let recencyWeight = 0;
    if (ageInHours < 1)
        recencyWeight = 50;
    else if (ageInHours < 6)
        recencyWeight = 30;
    else if (ageInHours < 24)
        recencyWeight = 10;
    // Get creator's follower count
    let followerBoost = 0;
    try {
        const creatorProfile = yield db.collection('userProfiles').doc(postData.userId).get();
        if (creatorProfile.exists) {
            const followerCount = ((_b = creatorProfile.data()) === null || _b === void 0 ? void 0 : _b.followerCount) || 0;
            // Follower boost: logarithmic scale (prevents mega-influencers from dominating)
            followerBoost = Math.log10(followerCount + 1) * 5; // Max ~15 for 1M followers
        }
    }
    catch (error) {
        console.error('Error getting follower count:', error);
    }
    // Enhanced algorithm
    const score = (postData.rewardCount || 0) * 0.5 +
        (postData.viewCount || 0) * 0.2 +
        (postData.likeCount || 0) * 0.2 +
        recencyWeight * 0.1 +
        followerBoost * 0.1; // NEW: Follower influence
    return Math.round(score * 100) / 100; // Round to 2 decimals
});
exports.calculateAlgorithmScore = calculateAlgorithmScore;
const updatePostScore = (postId, db) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const postRef = db.collection('posts').doc(postId);
        const postDoc = yield postRef.get();
        if (!postDoc.exists)
            return;
        const score = yield (0, exports.calculateAlgorithmScore)(postDoc.data(), db);
        yield postRef.update({
            score,
            lastScoreUpdate: admin.firestore.FieldValue.serverTimestamp(),
        });
    }
    catch (error) {
        console.error('Error updating post score:', error);
    }
});
exports.updatePostScore = updatePostScore;
