import admin from "../webhook/utils/firebase";
import { prisma } from "../prisma";
import { checkAuth } from "../webhook/utils/auth";
import axios from "axios";
import { generateUUID } from "../utils/uuid";
import { sendNotification } from "../webhook/notification";

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
      },
    );
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
    const userId = await checkAuth(req);
    const { clientRequestId, amount, reason, name, bankCode, accountNumber, humanRef } =
      req.body;

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
      return res
        .status(400)
        .json({ error: "failed to create transfer receipient" });
    }

    const transactionRef = generateUUID();

    const usersRef = admin.firestore().collection("users");
    const transfersRef = admin.firestore().collection("transfers");
    const transactionsRef = admin.firestore().collection("transactions");

    const userDoc = await usersRef.doc(userId).get();
    const notificationToken = userDoc?.data()?.notificationToken;

    // Idempotency check
    const existing = await transfersRef
      .where("clientRequestId", "==", req.body.clientRequestId)
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.json(existing.docs[0].data());
    }

    const transferDoc = transfersRef.doc(transactionRef);

    //locked user balance and create transfer record in firestore
    await admin.firestore().runTransaction(async (transaction) => {
      const userDoc = usersRef.doc(userId);

      const userSnap = await transaction.get(userDoc);

      const userBalance = userSnap.data()?.wallet.fiat.availableBalance;
      const wallet = userSnap.data()?.wallet.fiat;
      if (userBalance < amount) {
        throw new Error("Insufficient balance");
      }
      const newUserBalance = userBalance - amount;

      transaction.update(userDoc, {
        "wallet.fiat.availableBalance": newUserBalance,
        "wallet.fiat.lockedBalance": wallet.lockedBalance + amount,
      });

      // Create transfer doc
      transaction.set(transferDoc, {
        humanRef: humanRef,
        clientRequestId: clientRequestId,
        mode: "wallet",
        userId,
        amount: amount,
        status: "processing",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // Sender transaction
      transaction.set(transactionsRef.doc(transactionRef), {
        userId: userId,
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
        balanceBefore: userBalance,
        balanceAfter: newUserBalance,
        status: "processing",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    //initiate transfer on paystack
    const transferResponse = await axios.post(
      "https://api.paystack.co/transfer",
       {
        source: "balance",
        amount,
        reference: transactionRef,
        recipient: receipientResponse.data.recipient_code,
        reason: reason,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      },
     
    );

    if (notificationToken) {
      await sendNotification(
        notificationToken,
        "Transfer Initiated",
        `Your transfer of ₦${amount.toLocaleString()} has been initiated.`
      );
    }

    return res
      .status(200)
      .json({ status: true, transferId: transferDoc.id, transferStatus: transferResponse.data.data.status });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
  createExternalWithdrawal,
  fetchListOfBanks,
  resolveBankAccount,
};
