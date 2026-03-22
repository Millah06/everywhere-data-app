import axios from "axios";
import { prisma } from "../../../prisma";
import { generateUUID } from "../../../shared/utils/uuid";
import { sendNotification } from "../../../shared/utils/notification";
import { WalletService } from "../../../shared/services/wallet.service";
import {
  paystackTransferDataStatusToApi,
  prismaTransferStatusToApi,
  withTransactionStatus,
} from "../../../shared/utils/transactionResponse";

const fetchListOfBanks = async (req: any, res: any) => {
  try {
    const response = await axios.get(
      " https://api.paystack.co/bank?currency=NGN",
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      },
    );
    res.json({ success: true, banks: response.data.data });
  } catch (error: any) {
    console.error("Error fetching banks:", error);
    res.status(500).json({ error: "Failed to fetch list of banks" });
  }
};

const resolveBankAccount = async (req: any, res: any) => {
  try {
    const { accountNumber, bankCode } = req.params;
    const response = await axios.get(
      `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
        validateStatus: () => true,
      },
    );

    if (!response.data.status) {
      console.log("Failed to resolve bank account:", response.data);
      return res.status(200).json({
        success: false,
        message: "Invalid account number or bank",
        details: response.data,
      });
    }

    res.json({ success: true, account: response.data.data });
  } catch (error: any) {
    console.error("Error resolving bank account:", error);
    throw new Error("Failed to resolve bank account");
  }
};

const createTransferRecipient = async (
  userId: string,
  name: string,
  accountNumber: string,
  bankCode: string,
) => {
  try {
    const response = await axios.post(
      "https://api.paystack.co/transferrecipient",
      {
        type: "nuban",
        name,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: "NGN",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      },
    );
    return response.data;
  } catch (error: any) {
    console.error("Error creating transfer recipient:", error);
    throw new Error("Failed to create transfer recipient");
  }
};

const createExternalWithdrawal = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const {
      clientRequestId,
      amount,
      reason,
      name,
      bankCode,
      accountNumber,
      humanRef,
    } = req.body;

    if (!bankCode || !amount) {
      return res.status(400).json({ error: "Missing receiverUid or amount" });
    }

    const receipientResponse = await createTransferRecipient(
      userId,
      name,
      accountNumber,
      bankCode,
    );

    if (!receipientResponse.status) {
      console.log("Failed to create transfer recipient:", receipientResponse);
      return res
        .status(400)
        .json({ error: "failed to create transfer receipient" });
    }

    console.log("Pass creating :", receipientResponse);

    const transactionRef = generateUUID();

    const userDoc = await prisma.user.findUnique({
      where: { id: userId },
      select: { notificationToken: true },
    });
    const notificationToken = userDoc?.notificationToken;

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

    await WalletService.lockExternalWithdrawal({
      userId,
      amount,
      clientRequestId,
      humanRef,
      paystackRecipient: receipientResponse.data.recipient_code,
      transferId: transactionRef,
      metaData: {
        finalAmountToPay: amount,
        productName: "Wallet Transfer",
        direction: "debit",
        transactionID: humanRef,
      },
    });

    console.log("Calling Paystack transfer...");

    const transferResponse = await axios.post(
      "https://api.paystack.co/transfer",
      {
        source: "balance",
        amount: amount * 100,
        reference: transactionRef,
        recipient: receipientResponse.data.recipient_code,
        reason: reason,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
        validateStatus: () => true,
      },
    );

    if (!transferResponse.data.status) {
      console.log("Paystack transfer failed:", transferResponse.data);

      await WalletService.markExternalTransferAndTxFailed({
        transferId: transactionRef,
        userId,
        providerResponse: transferResponse.data,
      });

      if (notificationToken) {
        await sendNotification(
          notificationToken,
          "Transfer Initiated",
          `Your transfer of ₦${amount.toLocaleString()} has been failed`,
        );
      }

      return res.status(200).json(
        withTransactionStatus(
          {
            amount,
            transactionRef,
          },
          "FAILED",
          { message: transferResponse.data.message },
        ),
      );
    }

    console.log("Paystack response:", transferResponse.data);

    if (notificationToken) {
      await sendNotification(
        notificationToken,
        "Transfer Initiated",
        `Your transfer of ₦${amount.toLocaleString()} has been initiated.`,
      );
    }

    const paystackState = paystackTransferDataStatusToApi(
      transferResponse.data?.data?.status,
    );

    return res.status(200).json(
      withTransactionStatus(
        {
          transferId: transactionRef,
          transferStatus: transferResponse.data.data.status,
        },
        paystackState,
      ),
    );
  } catch (e: any) {
    console.error("Withdrawal error:", e?.response?.data || e);
    return res.status(500).json({
      error: e?.response?.data || e.message,
    });
  }
};

export default {
  createExternalWithdrawal,
  fetchListOfBanks,
  resolveBankAccount,
};
