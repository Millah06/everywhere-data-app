

const createChatTransfer = async (req: any, res: any) => {
        try { 
            const {amount, clientRequestId, humanRef, senderUid, receiverUid, roomId} = req.body;
            if (!amount || !clientRequestId || !humanRef || !senderUid || !receiverUid || !roomId) {
                return res.status(400).json({ error: "Missing required fields" });
            }
        }
        catch (error: any) {
            console.error("createChatTransfer error:", error.message, "RequestID:", req.body.clientRequestId);
            return res.status(500).json({ error: "Chat transfer failed", details: error.message });
        }
}

export default createChatTransfer;