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
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const auth_1 = require("../webhook/utils/auth");
const router = express_1.default.Router();
router.post("/verifyMerchant", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    try {
        yield (0, auth_1.checkAuth)(req);
        const { serviceID, meterNumber, meterType } = req.body;
        if (!serviceID || !meterNumber) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const response = yield axios_1.default.post("https://sandbox.vtpass.com/api/merchant-verify", {
            serviceID: serviceID,
            billersCode: meterNumber,
            type: meterType
        }, {
            headers: {
                "api-key": process.env.VTPASS_API_KEY,
                "secret-key": process.env.VTPASS_SECRET_KEY,
                "Content-Type": "application/json",
            },
        });
        return { status: "success", data: response.data };
    }
    catch (error) {
        console.error("Verify Merchant Error:", ((_a = error === null || error === void 0 ? void 0 : error.response) === null || _a === void 0 ? void 0 : _a.data) || error.message);
        return res.status(500).json({ error: "Verifying Merchant", details: (_b = error === null || error === void 0 ? void 0 : error.response) === null || _b === void 0 ? void 0 : _b.data });
    }
}));
exports.default = router;
