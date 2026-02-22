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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const auth_1 = require("../webhook/utils/auth");
const admin = __importStar(require("firebase-admin"));
const calculateTransaction_1 = require("../utils/calculateTransaction");
const sendAirtimeSecure = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    try {
        const { clientRequestId, network, phoneNumber, amount, humanRef, requestID, useReward, isRecharge, } = req.body;
        if (!phoneNumber || !amount || !network || !requestID || !clientRequestId) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const uid = yield (0, auth_1.checkAuth)(req); // Verify auth
        let responsePayload;
        const transactionDocRef = admin
            .firestore()
            .collection("transactions")
            .doc(clientRequestId);
        // Check for idempotency
        const existing = yield transactionDocRef.get();
        if (existing.exists) {
            return res.json(existing.data());
        }
        const userRef = admin.firestore().collection("users").doc(uid);
        const bonusDoc = yield admin
            .firestore()
            .collection("bonuses ")
            .doc("reward")
            .get();
        // Begin Firestore transaction
        yield admin.firestore().runTransaction((t) => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b, _c;
            const userDoc = yield t.get(userRef);
            if (!userDoc.exists)
                throw new Error("User not found");
            const wallet = (_b = (_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.wallet) === null || _b === void 0 ? void 0 : _b.fiat;
            const rewardBalance = (wallet === null || wallet === void 0 ? void 0 : wallet.rewardBalance) || 0;
            const bonusPercent = (_c = bonusDoc.data()) === null || _c === void 0 ? void 0 : _c.airtime;
            // Calculate how much to deduct from wallet
            const calculation = (0, calculateTransaction_1.calculateTransaction)({
                productAmount: Number(amount),
                rewardBalance,
                walletBalance: wallet.availableBalance,
                useReward,
                isRecharge,
                bonusPercent,
            });
            const finalAmountToPay = calculation.walletToDeduct;
            if (wallet.availableBalance < finalAmountToPay) {
                throw new Error("Insufficient balance");
            }
            // Lock the funds and create transaction doc
            t.update(userRef, {
                "wallet.fiat.availableBalance": wallet.availableBalance - finalAmountToPay,
                "wallet.fiat.lockedBalance": wallet.lockedBalance + finalAmountToPay,
            });
            t.set(transactionDocRef, {
                userId: uid,
                type: "utility",
                clientRequestId,
                metaData: {
                    finalAmountToPay,
                    phoneNumber,
                    productName: `${network.toUpperCase()} Airtime`,
                },
                humanRef,
                status: "processing",
                finalAmount: finalAmountToPay,
                rewardBalanceBefore: rewardBalance,
                finalRewardBalance: calculation.finalRewardBalance,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }));
        // Call third-party vendor
        let vendorResponse;
        try {
            const response = yield axios_1.default.post("https://vtpass.com/api/pay", {
                request_id: requestID,
                serviceID: network,
                amount,
                phone: phoneNumber,
            }, {
                headers: {
                    "api-key": process.env.VTPASS_API_KEY,
                    "secret-key": process.env.VTPASS_SECRET_KEY,
                },
                timeout: 15000, // 15 seconds timeout
            });
            vendorResponse = response.data;
        }
        catch (err) {
            vendorResponse = { error: err.message };
        }
        const transactionStatus = (_b = (_a = vendorResponse.content) === null || _a === void 0 ? void 0 : _a.transactions) === null || _b === void 0 ? void 0 : _b.status;
        console.log("Vendor response:", vendorResponse);
        // Final Firestore transaction to update locked balance and status
        yield admin.firestore().runTransaction((t) => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            const userDoc = yield t.get(userRef);
            const wallet = (_b = (_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.wallet) === null || _b === void 0 ? void 0 : _b.fiat;
            const rewardBalance = (wallet === null || wallet === void 0 ? void 0 : wallet.rewardBalance) || 0;
            // Retrieve calculation stored before
            const transactionData = (yield t.get(transactionDocRef)).data();
            const lockedAmount = (transactionData === null || transactionData === void 0 ? void 0 : transactionData.finalAmount) || 0;
            if (transactionStatus === "delivered") {
                // Deduct locked funds, add rewards
                t.update(userRef, {
                    "wallet.fiat.lockedBalance": wallet.lockedBalance - lockedAmount,
                    "wallet.fiat.rewardBalance": transactionData === null || transactionData === void 0 ? void 0 : transactionData.finalRewardBalance,
                });
                t.update(transactionDocRef, {
                    status: "success",
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    vendorResponse,
                });
                responsePayload = {
                    status: true,
                    transaction_id: humanRef,
                    date: transactionData === null || transactionData === void 0 ? void 0 : transactionData.updatedAt,
                };
            }
            else {
                // Refund locked funds, no reward
                t.update(userRef, {
                    "wallet.fiat.lockedBalance": wallet.lockedBalance - lockedAmount,
                    "wallet.fiat.availableBalance": wallet.availableBalance + lockedAmount,
                    "wallet.fiat.rewardBalance": rewardBalance,
                });
                t.update(transactionDocRef, {
                    status: "failed",
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    vendorResponse,
                });
                responsePayload = { status: false };
            }
        }));
        return res.json(responsePayload);
    }
    catch (error) {
        console.error("sendAirtimeSecure error:", error.message, "RequestID:", req.body.requestID, "UserID:", req.body.uid);
        // Optional: unlock funds if any transaction exists but got stuck
        try {
            const uid = yield (0, auth_1.checkAuth)(req);
            if (req.body.clientRequestId) {
                const txRef = admin
                    .firestore()
                    .collection("transactions")
                    .doc(req.body.clientRequestId);
                const txDoc = yield txRef.get();
                if (txDoc.exists && ((_c = txDoc.data()) === null || _c === void 0 ? void 0 : _c.status) === "processing") {
                    const userRef = admin.firestore().collection("users").doc(uid);
                    yield admin.firestore().runTransaction((t) => __awaiter(void 0, void 0, void 0, function* () {
                        var _a, _b, _c;
                        const userDoc = yield t.get(userRef);
                        const wallet = (_b = (_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.wallet) === null || _b === void 0 ? void 0 : _b.fiat;
                        const lockedAmount = ((_c = txDoc.data()) === null || _c === void 0 ? void 0 : _c.finalAmount) || 0;
                        t.update(userRef, {
                            "wallet.fiat.lockedBalance": wallet.lockedBalance - lockedAmount,
                            "wallet.fiat.availableBalance": wallet.availableBalance + lockedAmount,
                        });
                        t.update(txRef, {
                            status: "failed",
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                            error: "I failed here",
                        });
                    }));
                }
            }
        }
        catch (unlockError) {
            console.error("Error unlocking funds after failure:", unlockError);
        }
        return res.status(500).json({
            error: "Airtime failed",
            details: error.message,
        });
    }
});
exports.default = sendAirtimeSecure;
