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
const axios_1 = __importDefault(require("axios"));
const firebase_1 = __importDefault(require("../webhook/utils/firebase"));
const auth_1 = require("../webhook/utils/auth");
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const PAYSTACK_BASE_URL = "https://api.paystack.co";
const createVA = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const uid = yield (0, auth_1.checkAuth)(req);
        const { email, name, phone } = req.body;
        // ✅ Create Paystack Customer
        const customerRes = yield axios_1.default.post(`${PAYSTACK_BASE_URL}/customer`, {
            email,
            first_name: name.split(" ")[0],
            last_name: name.split(" ")[1] || "",
            phone
        }, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
        });
        const customerId = customerRes.data.data.customer_code;
        // ✅ Create Dedicated Virtual Account with UID in metadata
        const vaRes = yield axios_1.default.post(`${PAYSTACK_BASE_URL}/dedicated_account`, {
            customer: customerId,
            preferred_bank: "titan-paystack",
            metadata: { uid }
        }, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
        });
        const vaData = vaRes.data.data;
        // ✅ Save VA details to Firestore under users collection
        yield firebase_1.default.firestore().collection("users").doc(uid).set({
            balance: 0,
            reward: 0,
            va: {
                account_name: vaData.account_name,
                account_number: vaData.account_number,
                bank: vaData.bank.name,
                status: "active",
                createdAt: firebase_1.default.firestore.FieldValue.serverTimestamp()
            }
        }, { merge: true });
        res.status(200).json({ success: true, data: vaData });
    }
    catch (error) {
        console.error("Error creating VA:", ((_a = error.response) === null || _a === void 0 ? void 0 : _a.data) || error.message);
        res.status(500).json({ error: "Failed to create virtual account" });
    }
});
exports.default = createVA;
