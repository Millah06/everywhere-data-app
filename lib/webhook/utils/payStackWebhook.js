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
const crypto_1 = __importDefault(require("crypto"));
const firebase_1 = __importDefault(require("../utils/firebase"));
const notification_1 = require("../notification");
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const paystackWebhook = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    try {
        // ✅ Verify signature
        const signature = req.headers["x-paystack-signature"];
        const hash = crypto_1.default.createHmac("sha512", PAYSTACK_SECRET)
            .update(JSON.stringify(req.body))
            .digest("hex");
        if (hash !== signature) {
            res.status(401).send("Invalid signature");
            return;
        }
        const { event, data } = req.body;
        const docRef = firebase_1.default.firestore().collection('bonuses ').doc('reward');
        const doc = yield docRef.get();
        const docData = doc.data();
        if (event === "charge.success") {
            const fakeamount = data.amount / 100;
            const amount = fakeamount - (docData === null || docData === void 0 ? void 0 : docData.fundingFees);
            const email = data.customer.email;
            const senderName = ((_a = data.authorization) === null || _a === void 0 ? void 0 : _a.sender_name) || 'Unknown';
            const bankName = ((_b = data.authorization) === null || _b === void 0 ? void 0 : _b.sender_bank) || 'UnKnown';
            //   const uid = data.metadata?.uid;
            if (!email) {
                console.error("Missing UID in metadata");
                res.sendStatus(400);
                return;
            }
            const userQuery = yield firebase_1.default.firestore().collection("users")
                .where("email", "==", email)
                .limit(1).get();
            if (!userQuery.empty) {
                const userDoc = userQuery.docs[0];
                const userRef = userDoc.ref;
                const currentWallet = ((_c = userDoc.data()) === null || _c === void 0 ? void 0 : _c.balance) || 0;
                const notificationToken = userDoc.data().notificationToken;
                const userId = userDoc.id;
                // ✅ Update wallet balance
                yield userRef.update({
                    balance: currentWallet + amount,
                    updatedAt: firebase_1.default.firestore.FieldValue.serverTimestamp()
                });
                if (notificationToken) {
                    yield (0, notification_1.sendNotification)(notificationToken, 'Transfer Reeived', `You receeived ₦${amount} from ${senderName} via ${bankName}`);
                }
                const newFund = userDoc.data().recentFund;
                yield newFund.add({
                    amount,
                    type: "credit",
                    method: "Paystack VA",
                    description: `Wallet funding via ${data.authorization.bank}`,
                    timestamp: firebase_1.default.firestore.FieldValue.serverTimestamp(),
                });
                // ✅ Add transaction
                yield userRef.collection("transactions").add({
                    userId: userId,
                    amount,
                    type: "credit",
                    metaData: {},
                    method: "Paystack VA",
                    description: `Wallet funding via ${data.authorization.bank}`,
                    createdAt: firebase_1.default.firestore.FieldValue.serverTimestamp(),
                    status: "success",
                });
            }
        }
        res.sendStatus(200);
    }
    catch (error) {
        console.error("Webhook error:", error.message);
        res.sendStatus(200);
    }
});
exports.default = paystackWebhook;
