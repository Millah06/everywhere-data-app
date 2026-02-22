"use strict";
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
const firebase_1 = __importDefault(require("../webhook/utils/firebase"));
const transactionStatus = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { transactionId } = req.params;
    try {
        const txSnap = yield firebase_1.default.firestore()
            .collection("transactions")
            .where("humanRef", "==", transactionId)
            .limit(1)
            .get();
        if (txSnap.empty) {
            return res.status(404).json({
                status: 'failed',
                transaction_id: transactionId,
                message: 'Transaction not found',
                date: new Date().toISOString()
            });
        }
        const tx = txSnap.docs[0].data();
        return res.json(Object.assign(Object.assign({ status: tx.status === "success" ? true : tx.status === "failed" ? false : null, transaction_id: tx.humanRef, date: tx.updatedAt || tx.createdAt, message: tx.status === "processing" ? "Transaction still processing" : undefined }, tx.metaData), { finalAmount: tx.finalAmount || tx.metaData.amount }));
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({
            status: false,
            transaction_id: transactionId,
            message: 'Error fetching transaction',
            date: new Date().toISOString()
        });
    }
});
exports.default = transactionStatus;
