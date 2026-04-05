 
import { prisma } from "../../../prisma";
import {
  prismaTransactionStatusToApi,
  withTransactionStatus,
} from "../../../shared/utils/transactionResponse";
import crypto from "crypto";

/**
 * GET /wallet
 * Returns the authenticated user's wallet balances
 */
export const getWallet = async (req: any, res: any) => {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { userId: req.user!.id },
      include: { fiat: true },
    });

    if (!wallet) return res.status(404).json({ message: "Wallet not found." });

    return res.json({
      walletId: wallet.id,
      availableBalance: wallet.fiat?.availableBalance ?? 0,
      lockedBalance: wallet.fiat?.lockedBalance ?? 0,
      rewardBalance: wallet.fiat?.rewardBalance ?? 0,
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /wallet/transactions
 * Returns paginated transaction history for the authenticated user
 * Query: page, limit, status, type
 */
export const getWalletTransactions = async (req: any, res: any) => {
  try {
    const {
      page = "1",
      limit = "20",
      status,
      type,
    } = req.query as Record<string, string>;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      userId: req.user!.id,
      ...(status && { status: status as any }),
      ...(type && { type }),
    };

    const [transactions, total] = await prisma.$transaction([
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: parseInt(limit),
        select: {
          id: true,
          type: true,
          amount: true,
          status: true,
          message: true,
          transactionRef: true,
          createdAt: true,
        },
      }),
      prisma.transaction.count({ where }),
    ]);

    return res.json({
      data: transactions.map((t) => ({
        ...t,
        transactionStatus: prismaTransactionStatusToApi(t.status),
      })),
      meta: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADD THIS to your existing wallet.controller.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /wallet/transactions/:id
 * Returns the full transaction including metaData for receipt rendering.
 * Only the authenticated user's own transactions are accessible.
 */
export const getTransactionDetail = async (req: any, res: any) => {
  try {
    const { id } = req.params as { id: string };

    const transaction = await prisma.transaction.findFirst({
      where: {
        id,
        userId: req.user!.id, // scoped to authenticated user — never expose other users' data
      },
      select: {
        id: true,
        type: true,
        amount: true,
        status: true,
        message: true,
        transactionRef: true,
        humanRef: true,
        clientRequestId: true,
        metaData: true,
        orderId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found." });
    }

    return res.json({
      data: {
        ...transaction,
        transactionStatus: prismaTransactionStatusToApi(transaction.status),
      },
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * POST /wallet/webhook/paystack
 * Paystack webhook handler — credits user wallet on successful charge
 * This endpoint should be public (no auth middleware) but validated via HMAC
 */
export const paystackWebhook = async (req: any, res: any) => {
  try {
    // 1. Validate Paystack signature
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY!)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(400).json({ message: "Invalid signature." });
    }

    // Acknowledge Paystack immediately (within 5s)
    res.sendStatus(200);

    const { event, data } = req.body;

    if (event !== "charge.success") return;

    const { reference, amount, metadata, customer } = data;
    const amountInNaira = amount / 100; // Paystack sends kobo

    // Idempotency — skip if this reference was already processed
    const existing = await prisma.transaction.findFirst({
      where: { transactionRef: reference, status: "success" },
    });
    if (existing) return;

    // Find user by email or metadata userId
    const userId: string | undefined = metadata?.userId;
    const user = userId
      ? await prisma.user.findUnique({ where: { id: userId } })
      : await prisma.user.findUnique({ where: { email: customer.email } });

    if (!user) {
      console.error(`[Paystack Webhook] User not found for reference: ${reference}`);
      return;
    }

    const wallet = await prisma.wallet.findUnique({
      where: {userId}
    })

     if (!wallet) {
      console.error(`No wallet fund: ${reference}`);
      return;
    }

    // Credit wallet in a transaction
    await prisma.$transaction(async (tx) => {
      await tx.fiat.update({
        where: { walletId: wallet?.id },
        data: { availableBalance: { increment: amountInNaira } },
      });

      await tx.transaction.create({
        data: {
          userId: user.id,
          type: "credit",
          amount: amountInNaira,
          transactionRef: reference,
          status: "success",
          message: `Wallet funded via Paystack`,
          metaData: { source: "paystack", paystackData: data },
        },
      });
    });

    console.log(`[Paystack] Credited ₦${amountInNaira} to user ${user.id}`);
  } catch (e: any) {
    console.error("[Paystack Webhook Error]", e.message);
  }
};

/**
 * POST /wallet/transfer
 * Internal wallet-to-wallet transfer between users
 * Body: { recipientTransferUid, amount, note? }
 */
export const internalTransfer = async (req: any, res: any) => {
  try {
    const senderId = req.user!.id;
    const { recipientTransferUid, amount, note } = req.body;

    if (!recipientTransferUid || !amount) {
      return res.status(400).json({ message: "recipientTransferUid and amount are required." });
    }

    if (amount <= 0) {
      return res.status(400).json({ message: "Amount must be greater than 0." });
    }

    const recipient = await prisma.user.findUnique({
      where: { transferUid: recipientTransferUid },
      select: { id: true, name: true, active: true },
    });

    if (!recipient) return res.status(404).json({ message: "Recipient not found." });
    if (!recipient.active) return res.status(400).json({ message: "Recipient account is inactive." });
    if (recipient.id === senderId) return res.status(400).json({ message: "Cannot transfer to yourself." });

    const senderFiat = await prisma.fiat.findFirst({
      where: { wallet: { userId: senderId } },
    });

    if (!senderFiat || senderFiat.availableBalance < amount) {
      return res.status(400).json({ message: "Insufficient balance." });
    }

    const ref = `TRF-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    await prisma.$transaction(async (tx) => {
      // Debit sender
      await tx.fiat.update({
        where: { id: senderFiat.id },
        data: { availableBalance: { decrement: amount } },
      });

      const wallet = await prisma.wallet.findUnique({
      where: {userId : recipient.id}
    })

     if (!wallet) {
      console.error(`No wallet fund:`);
      return;
    }
      // Credit recipient
      await tx.fiat.update({
        where: { walletId: wallet.id},
        data: { availableBalance: { increment: amount } },
      });

      // Create both transaction records
      await tx.transaction.createMany({
        data: [
          {
            userId: senderId,
            type: "debit",
            amount,
            transactionRef: ref,
            status: "success",
            message: note ?? `Transfer to ${recipient.name}`,
            metaData: { transferTo: recipient.id, recipientTransferUid },
          },
          {
            userId: recipient.id,
            type: "credit",
            amount,
            transactionRef: `${ref}-R`,
            status: "success",
            message: note ?? `Transfer received`,
            metaData: { transferFrom: senderId },
          },
        ],
      });
    });

    return res.json(
      withTransactionStatus(
        {
          message: "Transfer successful.",
          reference: ref,
        },
        "SUCCESS",
      ),
    );
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default {
    getWallet,
    getWalletTransactions,
    getTransactionDetail,
    paystackWebhook,
    internalTransfer,
}