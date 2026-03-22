import { sendNotification } from "../../../shared/utils/notification";
import { WalletService } from "../../../shared/services/wallet.service";
import { prisma } from "../../../prisma";
import {
  prismaTransferStatusToApi,
  withTransactionStatus,
} from "../../../shared/utils/transactionResponse";

const createWalletTransfer = async (req: any, res: any) => {
  try {
    const { amount, clientRequestId, humanRef, senderUid, receiverUid } =
      req.body;

    if (!receiverUid || !amount) {
      return res.status(400).json({ error: "Missing receiverUid or amount" });
    }

    const sender = await prisma.user.findUnique({
      where: { firebaseUid: senderUid },
    });
    const receiver = await prisma.user.findUnique({
      where: { firebaseUid: receiverUid },
    });

    if (!sender || !receiver) {
      return res.status(400).json({ error: "Sender or receiver not found" });
    }

    const notificationToken = receiver.notificationToken;
    const senderName = receiver.name || "Unknown";
    const bankName = "Nexpay Wallet";

    const existing = await prisma.transfer.findUnique({
      where: { clientRequestId },
    });
    if (existing) {
      const transactionStatus = prismaTransferStatusToApi(existing.status);
      return res.json(
        withTransactionStatus(
          { ...existing } as Record<string, unknown>,
          transactionStatus,
          { omitStatus: true },
        ),
      );
    }

    const result = await WalletService.executeInternalWalletTransfer({
      senderId: sender.id,
      receiverId: receiver.id,
      amount,
      clientRequestId,
      humanRef,
      metaData: {
        finalAmountToPay: amount,
        productName: "Wallet Transfer",
        transactionID: humanRef,
      },
    });

    if (result.idempotent) {
      const transactionStatus = prismaTransferStatusToApi(
        result.transfer.status,
      );
      return res.json(
        withTransactionStatus(
          { ...result.transfer } as Record<string, unknown>,
          transactionStatus,
          { omitStatus: true },
        ),
      );
    }

    if (notificationToken) {
      await sendNotification(
        notificationToken,
        "Transfer Received",
        `You received ₦${amount} from ${senderName} via ${bankName}`,
      );
    }

    return res.status(200).json({
      status: "success",
      transferId: result.transfer.id,
      transactionStatus: "SUCCESS" as const,
    });
  } catch (error: any) {
    console.error("createWalletTransfer error:", error.message);
    return res
      .status(500)
      .json({ error: "Transfer failed", details: error.message });
  }
};

export default createWalletTransfer;
