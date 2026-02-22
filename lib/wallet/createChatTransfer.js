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
Object.defineProperty(exports, "__esModule", { value: true });
const createChatTransfer = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { amount, clientRequestId, humanRef, senderUid, receiverUid, roomId } = req.body;
        if (!amount || !clientRequestId || !humanRef || !senderUid || !receiverUid || !roomId) {
            return res.status(400).json({ error: "Missing required fields" });
        }
    }
    catch (error) {
        console.error("createChatTransfer error:", error.message, "RequestID:", req.body.clientRequestId);
        return res.status(500).json({ error: "Chat transfer failed", details: error.message });
    }
});
exports.default = createChatTransfer;
