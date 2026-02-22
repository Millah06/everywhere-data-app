"use strict";
// backend/controllers/badgeController.ts
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
const BADGE_TYPES = {
    kyc_blue: 'KYC Verified',
    premium_paid: 'Premium Member',
    business: 'Business Account',
    creator_earnings: 'Top Creator',
};
const awardBadge = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const adminId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const { userId, badgeType, expiresAt, metadata } = req.body;
        // TODO: Verify admin permissions
        // if (!isAdmin(adminId)) return res.status(403).json({ error: 'Unauthorized' });
        if (!userId || !badgeType) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!Object.keys(BADGE_TYPES).includes(badgeType)) {
            return res.status(400).json({ error: 'Invalid badge type' });
        }
        const badgeRef = db.collection('userBadges').doc(userId);
        const badgeDoc = yield badgeRef.get();
        const badgeData = Object.assign(Object.assign({ awarded: true, awardedAt: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(), awardedBy: adminId }, (expiresAt && { expiresAt: firebase_admin_1.default.firestore.Timestamp.fromDate(new Date(expiresAt)) })), (metadata && { metadata }));
        if (badgeDoc.exists) {
            yield badgeRef.update({
                [`badges.${badgeType}`]: badgeData,
                lastUpdated: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            });
        }
        else {
            yield badgeRef.set({
                userId,
                badges: {
                    [badgeType]: badgeData,
                },
                lastUpdated: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            });
        }
        res.json({ success: true, message: `Badge ${badgeType} awarded to user` });
    }
    catch (error) {
        console.error('Award badge error:', error);
        res.status(500).json({ error: 'Failed to award badge' });
    }
});
const revokeBadge = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const adminId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid;
        const { userId, badgeType } = req.body;
        // TODO: Verify admin permissions
        if (!userId || !badgeType) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        yield db.collection('userBadges').doc(userId).update({
            [`badges.${badgeType}.awarded`]: false,
            [`badges.${badgeType}.revokedAt`]: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
            [`badges.${badgeType}.revokedBy`]: adminId,
            lastUpdated: firebase_admin_1.default.firestore.FieldValue.serverTimestamp(),
        });
        res.json({ success: true, message: `Badge ${badgeType} revoked from user` });
    }
    catch (error) {
        console.error('Revoke badge error:', error);
        res.status(500).json({ error: 'Failed to revoke badge' });
    }
});
const getUserBadges = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const { userId } = req.params;
        const badgeDoc = yield db.collection('userBadges').doc(userId).get();
        if (!badgeDoc.exists) {
            return res.json({ success: true, badges: {} });
        }
        const badges = ((_a = badgeDoc.data()) === null || _a === void 0 ? void 0 : _a.badges) || {};
        // Filter only awarded badges that haven't expired
        const now = Date.now();
        const activeBadges = Object.entries(badges).reduce((acc, [type, data]) => {
            var _a, _b;
            if (data.awarded) {
                const expiresAt = (_a = data.expiresAt) === null || _a === void 0 ? void 0 : _a.toMillis();
                if (!expiresAt || expiresAt > now) {
                    acc[type] = Object.assign(Object.assign({}, data), { awardedAt: (_b = data.awardedAt) === null || _b === void 0 ? void 0 : _b.toMillis(), expiresAt: expiresAt || null });
                }
            }
            return acc;
        }, {});
        res.json({ success: true, badges: activeBadges });
    }
    catch (error) {
        console.error('Get badges error:', error);
        res.status(500).json({ error: 'Failed to get badges' });
    }
});
exports.default = {
    awardBadge,
    revokeBadge,
    getUserBadges,
};
