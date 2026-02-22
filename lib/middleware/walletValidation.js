"use strict";
// backend/middleware/walletValidation.ts
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
exports.validateSufficientBalance = void 0;
const validateSufficientBalance = (requiredAmount) => {
    return (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        try {
            const userId = (_a = req.user) === null || _a === void 0 ? void 0 : _a.uid; // Assuming Firebase Auth middleware sets this
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            // Assume wallet helper exists
            const { getWalletBalance } = require('../helpers/walletHelper');
            const balance = yield getWalletBalance(userId);
            if (balance < requiredAmount) {
                return res.status(400).json({
                    error: 'Insufficient balance',
                    required: requiredAmount,
                    available: balance,
                });
            }
            req.walletBalance = balance;
            next();
        }
        catch (error) {
            console.error('Wallet validation error:', error);
            res.status(500).json({ error: 'Failed to validate wallet balance' });
        }
    });
};
exports.validateSufficientBalance = validateSufficientBalance;
