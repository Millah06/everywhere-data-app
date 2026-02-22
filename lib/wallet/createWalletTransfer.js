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
const notification_1 = require("../webhook/notification");
const firebase_1 = __importDefault(require("../webhook/utils/firebase"));
const createWalletTransfer = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    try {
        const { amount, clientRequestId, humanRef, senderUid, receiverUid } = req.body;
        if (!receiverUid || !amount) {
            return res.status(400).json({ error: "Missing receiverUid or amount" });
        }
        const usersRef = firebase_1.default.firestore().collection("users");
        const transfersRef = firebase_1.default.firestore().collection("transfers");
        const transactionsRef = firebase_1.default.firestore().collection("transactions");
        const sendertransactionDoc = transactionsRef.doc();
        const receivertransactionDoc = transactionsRef.doc();
        const userDoc = yield usersRef.doc(receiverUid).get();
        const notificationToken = (_a = userDoc === null || userDoc === void 0 ? void 0 : userDoc.data()) === null || _a === void 0 ? void 0 : _a.notificationToken;
        const senderName = ((_b = userDoc === null || userDoc === void 0 ? void 0 : userDoc.data()) === null || _b === void 0 ? void 0 : _b.name) || "Unknown";
        const bankName = "Nexpay Wallet";
        // Idempotency check
        const existing = yield transfersRef
            .where("clientRequestId", "==", req.body.clientRequestId)
            .limit(1)
            .get();
        if (!existing.empty) {
            return res.json(existing.docs[0].data());
        }
        const transferDoc = transfersRef.doc(clientRequestId);
        yield firebase_1.default.firestore().runTransaction((transaction) => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            const senderDoc = usersRef.doc(senderUid);
            const receiverDoc = usersRef.doc(receiverUid);
            const senderSnap = yield transaction.get(senderDoc);
            const receiverSnap = yield transaction.get(receiverDoc);
            const senderBalance = (_a = senderSnap.data()) === null || _a === void 0 ? void 0 : _a.wallet.fiat.availableBalance;
            if (senderBalance < amount) {
                throw new Error("Insufficient balance");
            }
            const newSenderBalance = senderBalance - amount;
            const receiverBalance = (_b = receiverSnap.data()) === null || _b === void 0 ? void 0 : _b.wallet.fiat.availableBalance;
            const newReceiverBalance = receiverBalance + amount;
            transaction.update(senderDoc, {
                "wallet.fiat.availableBalance": newSenderBalance,
            });
            transaction.update(receiverDoc, {
                "wallet.fiat.availableBalance": newReceiverBalance,
            });
            // Create transfer doc
            transaction.set(transferDoc, {
                humanRef: humanRef,
                clientRequestId: clientRequestId,
                mode: "wallet",
                senderUid: senderUid,
                receiverUid: receiverUid,
                amount: amount,
                status: "processing",
                createdAt: firebase_1.default.firestore.FieldValue.serverTimestamp(),
            });
            // Sender transaction
            transaction.set(transactionsRef.doc(), {
                userId: senderUid,
                transferId: transferDoc.id,
                metaData: {
                    finalAmountToPay: amount,
                    productName: "Wallet Transfer",
                    direction: "debit",
                    transactionID: humanRef,
                },
                type: "wallet",
                clientRequestId,
                amount: amount,
                balanceBefore: senderBalance,
                balanceAfter: newSenderBalance,
                status: "processing",
                createdAt: firebase_1.default.firestore.FieldValue.serverTimestamp(),
            });
            // Receiver transaction
            transaction.set(transactionsRef.doc(), {
                userId: receiverUid,
                transferId: transferDoc.id,
                metaData: {
                    finalAmountToPay: amount,
                    productName: "Wallet Transfer",
                    direction: "credit",
                    transactionID: humanRef,
                },
                type: "wallet",
                clientRequestId,
                amount: amount,
                balanceBefore: receiverBalance,
                balanceAfter: newReceiverBalance,
                status: "processing",
                createdAt: firebase_1.default.firestore.FieldValue.serverTimestamp(),
            });
        }));
        // 2️⃣ Update transfer to success AFTER transaction
        yield transferDoc.update({
            status: "success",
            updatedAt: firebase_1.default.firestore.FieldValue.serverTimestamp(),
        });
        yield sendertransactionDoc.update({
            status: "success",
            updatedAt: firebase_1.default.firestore.FieldValue.serverTimestamp(),
        });
        yield receivertransactionDoc.update({
            status: "success",
            updatedAt: firebase_1.default.firestore.FieldValue.serverTimestamp(),
        });
        if (notificationToken) {
            yield (0, notification_1.sendNotification)(notificationToken, "Transfer Received", `You received ₦${amount} from ${senderName} via ${bankName}`);
        }
        return res
            .status(200)
            .json({ status: "success", transferId: transferDoc.id });
    }
    catch (error) {
        console.error("createWalletTransfer error:", error.message);
        return res
            .status(500)
            .json({ error: "Transfer failed", details: error.message });
    }
});
exports.default = createWalletTransfer;
