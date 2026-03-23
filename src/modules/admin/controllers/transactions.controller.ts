import {prisma} from "../../../prisma"

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/transactions
 * All transactions with filters and pagination
 * Query: page, limit, status, type, userId, from, to
 */
const getAllTransactions = async (req: any, res: any) => {
  try {
    const {
      page = "1",
      limit = "20",
      status,
      type,
      userId,
      from,
      to,
    } = req.query as Record<string, string>;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where: any = {
      ...(status && { status: status }),
      ...(type && { type }),
      ...(userId && { userId }),
      ...((from || to) && {
        createdAt: {
          ...(from && { gte: new Date(from) }),
          ...(to && { lte: new Date(to) }),
        },
      }),
    };

    const [transactions, total, volumeAgg] = await prisma.$transaction([
      prisma.transaction.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.transaction.count({ where }),
      prisma.transaction.aggregate({
        where,
        _sum: { amount: true },
      }),
    ]);

    return res.json({
      data: transactions,
      meta: {
        total,
        totalVolume: volumeAgg._sum.amount ?? 0,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * GET /admin/transactions/search?ref=...
 * Find a transaction by its reference string
 */
const searchTransactionByRef = async (req: any, res: any) => {
  try {
    const { ref } = req.query as { ref: string };
    if (!ref) return res.status(400).json({ message: "ref query param is required." });

    const transaction = await prisma.transaction.findFirst({
      where: { transactionRef: { contains: ref, mode: "insensitive" } },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    if (!transaction) return res.status(404).json({ message: "Transaction not found." });

    return res.json(transaction);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * POST /admin/transactions/:transactionId/refund
 * Refund a transaction — credits the user's wallet back
 * Body: { reason }
 */
const refundTransaction = async (req: any, res: any) => {
  try {
    const { transactionId } = req.params;
    const { reason } = req.body;

    const original = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { user: true },
    });

    if (!original) return res.status(404).json({ message: "Transaction not found." });
    if (original.status !== "success") {
      return res.status(400).json({ message: "Only successful transactions can be refunded." });
    }
    if (original.type !== "debit") {
      return res.status(400).json({ message: "Only debit transactions can be refunded." });
    }

     const fiat = await prisma.fiat.findFirst({ where: { wallet: { userId: original.userId } } });
    if (!fiat) return res.status(404).json({ message: "Wallet not found." });

    // Check if already refunded (look for a refund record)
    const existingRefund = await prisma.transaction.findFirst({
      where: {
        metaData: { path: ["refundOf"], equals: transactionId },
      },
    });
    if (existingRefund) {
      return res.status(409).json({ message: "This transaction has already been refunded." });
    }

    const refundRef = `RFD-${original.transactionRef ?? transactionId}`;

    await prisma.$transaction(async (tx) => {
      // Credit wallet back
      await tx.fiat.update({
        where: { id: fiat.id },
        data: { availableBalance: { increment: original.amount } },
      });

      // Create refund transaction record
      await tx.transaction.create({
        data: {
          userId: original.userId,
          type: "credit",
          amount: original.amount,
          transactionRef: refundRef,
          status: "success",
          message: `Refund: ${reason ?? "Admin refund"}`,
          metaData: {
            refundOf: transactionId,
            reason,
            refundedBy: req.user!.id,
          },
        },
      });

      // Mark original as refunded
      await tx.transaction.update({
        where: { id: transactionId },
        data: {
          metaData: {
            ...(original.metaData as object ?? {}),
            refunded: true,
            refundRef,
            refundedAt: new Date().toISOString(),
          },
        },
      });
    });

    return res.json({ message: "Refund processed successfully.", refundRef });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * POST /admin/transactions/manual-credit
 * Manually credit a user's wallet (for support adjustments, bonuses, etc.)
 * Body: { userId, amount, reason }
 */
const manualCredit = async (req: any, res: any) => {
  try {

    const { amount, reason, userId } = req.body;

    if (!userId || !amount || !reason) {
      return res.status(400).json({ message: "userId, amount and reason are required." });
    }
    if (amount <= 0) return res.status(400).json({ message: "Amount must be positive." });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found." });

    const ref = `MCR-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    const fiat = await prisma.fiat.findFirst({ where: { wallet: { userId } } });

    await prisma.$transaction(async (tx) => {
      await tx.fiat.update({
        where: { id: fiat?.id},
        data: { availableBalance: { increment: amount } },
      });

      await tx.transaction.create({
        data: {
          userId,
          type: "credit",
          amount,
          transactionRef: ref,
          status: "success",
          message: reason,
          metaData: { manualCredit: true, creditedBy: req.user!.id },
        },
      });
    });

    return res.json({ message: `₦${amount} credited to ${user.name}.`, reference: ref });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * POST /admin/transactions/manual-debit
 * Manually debit a user's wallet (clawbacks, fee corrections)
 * Body: { userId, amount, reason }
 */
const manualDebit = async (req: any, res: any) => {
  try {

    const { amount, reason, userId } = req.body;

    if (!userId || !amount || !reason) {
      return res.status(400).json({ message: "userId, amount and reason are required." });
    }

    const fiat = await prisma.fiat.findFirst({ where: { wallet: { userId } } });
    if (!fiat) return res.status(404).json({ message: "Wallet not found." });
    if (fiat.availableBalance < amount) {
      return res.status(400).json({ message: "Insufficient balance for this debit." });
    }

    const ref = `MDB-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    await prisma.$transaction(async (tx) => {
      await tx.fiat.update({
        where: { id: fiat.id },
        data: { availableBalance: { decrement: amount } },
      });

      await tx.transaction.create({
        data: {
          userId,
          type: "debit",
          amount,
          transactionRef: ref,
          status: "success",
          message: reason,
          metaData: { manualDebit: true, debitedBy: req.user!.id },
        },
      });
    });

    return res.json({ message: `₦${amount} debited from user.`, reference: ref });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default {
  getAllTransactions,
  manualCredit,
  manualDebit,
  refundTransaction,
  searchTransactionByRef,

}