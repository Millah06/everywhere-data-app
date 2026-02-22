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
exports.deductWalletTransactional = exports.creditWalletTransactional = exports.deductWallet = exports.creditWallet = exports.getWalletBalance = void 0;
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
/**
 * Get user's available wallet balance
 */
const getWalletBalance = (userId) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d;
    const userRef = db.collection('users').doc(userId);
    const userSnap = yield userRef.get();
    if (!userSnap.exists) {
        throw new Error('User not found');
    }
    return (_d = (_c = (_b = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.wallet) === null || _b === void 0 ? void 0 : _b.fiat) === null || _c === void 0 ? void 0 : _c.availableBalance) !== null && _d !== void 0 ? _d : 0;
});
exports.getWalletBalance = getWalletBalance;
/**
 * Credit user's available balance (NO TRANSACTION - for use inside transactions)
 */
const creditWallet = (userId, amount) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d;
    if (amount <= 0) {
        throw new Error('Amount must be greater than zero');
    }
    const userRef = db.collection('users').doc(userId);
    const userSnap = yield userRef.get();
    if (!userSnap.exists) {
        throw new Error('User not found');
    }
    const currentBalance = (_d = (_c = (_b = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.wallet) === null || _b === void 0 ? void 0 : _b.fiat) === null || _c === void 0 ? void 0 : _c.availableBalance) !== null && _d !== void 0 ? _d : 0;
    const updatedBalance = currentBalance + amount;
    yield userRef.update({
        'wallet.fiat.availableBalance': updatedBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return updatedBalance;
});
exports.creditWallet = creditWallet;
/**
 * Deduct from user's available balance (NO TRANSACTION - for use inside transactions)
 */
const deductWallet = (userId, amount) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d;
    if (amount <= 0) {
        throw new Error('Amount must be greater than zero');
    }
    const userRef = db.collection('users').doc(userId);
    const userSnap = yield userRef.get();
    if (!userSnap.exists) {
        throw new Error('User not found');
    }
    const currentBalance = (_d = (_c = (_b = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.wallet) === null || _b === void 0 ? void 0 : _b.fiat) === null || _c === void 0 ? void 0 : _c.availableBalance) !== null && _d !== void 0 ? _d : 0;
    if (currentBalance < amount) {
        throw new Error('Insufficient balance');
    }
    const updatedBalance = currentBalance - amount;
    yield userRef.update({
        'wallet.fiat.availableBalance': updatedBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return updatedBalance;
});
exports.deductWallet = deductWallet;
/**
 * TRANSACTIONAL versions for standalone use (when not inside another transaction)
 */
const creditWalletTransactional = (userId, amount) => __awaiter(void 0, void 0, void 0, function* () {
    if (amount <= 0) {
        throw new Error('Amount must be greater than zero');
    }
    const userRef = db.collection('users').doc(userId);
    const newBalance = yield db.runTransaction((transaction) => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const userSnap = yield transaction.get(userRef);
        if (!userSnap.exists) {
            throw new Error('User not found');
        }
        const currentBalance = (_d = (_c = (_b = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.wallet) === null || _b === void 0 ? void 0 : _b.fiat) === null || _c === void 0 ? void 0 : _c.availableBalance) !== null && _d !== void 0 ? _d : 0;
        const updatedBalance = currentBalance + amount;
        transaction.update(userRef, {
            'wallet.fiat.availableBalance': updatedBalance,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return updatedBalance;
    }));
    return newBalance;
});
exports.creditWalletTransactional = creditWalletTransactional;
const deductWalletTransactional = (userId, amount) => __awaiter(void 0, void 0, void 0, function* () {
    if (amount <= 0) {
        throw new Error('Amount must be greater than zero');
    }
    const userRef = db.collection('users').doc(userId);
    const newBalance = yield db.runTransaction((transaction) => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const userSnap = yield transaction.get(userRef);
        if (!userSnap.exists) {
            throw new Error('User not found');
        }
        const currentBalance = (_d = (_c = (_b = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.wallet) === null || _b === void 0 ? void 0 : _b.fiat) === null || _c === void 0 ? void 0 : _c.availableBalance) !== null && _d !== void 0 ? _d : 0;
        if (currentBalance < amount) {
            throw new Error('Insufficient balance');
        }
        const updatedBalance = currentBalance - amount;
        transaction.update(userRef, {
            'wallet.fiat.availableBalance': updatedBalance,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return updatedBalance;
    }));
    return newBalance;
});
exports.deductWalletTransactional = deductWalletTransactional;
