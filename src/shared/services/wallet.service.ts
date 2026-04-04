import {
  Prisma,
  TransactionStatus,
  TransferStatus,
  type Fiat,
} from "@prisma/client";
import { prisma } from "../../prisma";

export type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export class WalletService {
  static generateTransactionRef(): string {
    const now = new Date();
    const utcPlus1 = new Date(now.getTime() + 60 * 60 * 1000);
    const year = utcPlus1.getUTCFullYear();
    const month = String(utcPlus1.getUTCMonth() + 1).padStart(2, "0");
    const day = String(utcPlus1.getUTCDate()).padStart(2, "0");
    const hours = String(utcPlus1.getUTCHours()).padStart(2, "0");
    const minutes = String(utcPlus1.getUTCMinutes()).padStart(2, "0");
    const dateTimePart = `${year}${month}${day}${hours}${minutes}`;
    let uuidPart = "";
    for (let i = 0; i < 6; i++) {
      uuidPart += Math.floor(Math.random() * 10).toString();
    }
    return `${dateTimePart}${uuidPart}`;
  }

  static async ensureWalletWithFiat(
    tx: PrismaTx,
    userId: string,
  ): Promise<{ walletId: string; fiat: Fiat }> {
    let wallet = await tx.wallet.findUnique({
      where: { userId },
      include: { fiat: true },
    });
    if (!wallet) {
      wallet = await tx.wallet.create({
        data: {
          userId,
          fiat: { create: {} },
        },
        include: { fiat: true },
      });
    }
    if (!wallet.fiat) {
      const fiat = await tx.fiat.create({
        data: { walletId: wallet.id },
      });
      return { walletId: wallet.id, fiat };
    }
    return { walletId: wallet.id, fiat: wallet.fiat };
  }

  static async getBonusConfig(): Promise<{
    fundingFees: number;
    airtime: number;
    data: number;
    cable: number;
    electric: number;
  }> {
    const cfg = await prisma.appConfig.findFirst();
    return {
      fundingFees: cfg?.fundingFees ?? 0,
      airtime: cfg?.bonusAirtime ?? 0,
      data: cfg?.bonusData ?? 0,
      cable: cfg?.bonusCable ?? 0,
      electric: cfg?.bonusElectric ?? 0,
    };
  }

  /**
   * Utility / VTpass: lock wallet fiat, create pending Transaction.
   * Balance source of truth: Fiat (availableBalance / lockedBalance / rewardBalance).
   */
  static async lockUtilityFundsAndCreateTx(input: {
    userId: string;
    clientRequestId: string;
    humanRef: string;
    /** Passed to vendor as request_id — used for webhook + Transaction.transactionRef */
    vendorRequestId: string;
    walletToDeduct: number;
    rewardBalanceBefore: number;
    finalRewardBalance: number;
    useReward: boolean;
    isRecharge: boolean;
    bonusPercent: number;
    productAmount: number;
    metaData: Prisma.JsonObject;
  }) {
    const {
      userId,
      clientRequestId,
      humanRef,
      vendorRequestId,
      walletToDeduct,
      rewardBalanceBefore,
      finalRewardBalance,
      useReward,
      isRecharge,
      bonusPercent,
      productAmount,
      metaData,
    } = input;

    if (walletToDeduct <= 0) {
      throw new Error("Invalid deduction amount");
    }

    return prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findUnique({
        where: { clientRequestId },
      });
      if (existing) {
        return { idempotent: true as const, transaction: existing };
      }

      const { fiat } = await this.ensureWalletWithFiat(tx, userId);

      if (fiat.availableBalance < walletToDeduct) {
        throw new Error("Insufficient balance");
      }

      await tx.fiat.update({
        where: { id: fiat.id },
        data: {
          availableBalance: { decrement: walletToDeduct },
          lockedBalance: { increment: walletToDeduct },
        },
      });

      const mergedMeta: Prisma.JsonObject = {
        ...metaData,
        walletToDeduct,
        rewardBalanceBefore,
        finalRewardBalance,
        useReward,
        isRecharge,
        bonusPercent,
        productAmount,
      };

      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: "utility",
          amount: walletToDeduct,
          status: TransactionStatus.pending,
          clientRequestId,
          humanRef,
          transactionRef: vendorRequestId,
          metaData: mergedMeta,
        },
      });

      return { idempotent: false as const, transaction };
    });
  }

  /**
   * After vendor responds: finalize success (consume locked + rewards) or failure (refund).
   */
  static async finalizeUtilityTransaction(input: {
    userId: string;
    clientRequestId: string;
    delivered: boolean;
    vendorResponse: unknown;
    /** e.g. cable/electricity token path */
    patchMeta?: (meta: Prisma.JsonObject) => void;
    /** When set (e.g. buyData second-phase recalculation), overrides meta.finalRewardBalance */
    successRewardBalanceOverride?: number;
  }) {
    const {
      userId,
      clientRequestId,
      delivered,
      vendorResponse,
      patchMeta,
      successRewardBalanceOverride,
    } = input;

    return prisma.$transaction(async (tx) => {
      const row = await tx.transaction.findUnique({
        where: { clientRequestId },
      });
      if (!row || row.userId !== userId) {
        throw new Error("Transaction not found");
      }
      if (row.status !== TransactionStatus.pending) {
        return { alreadyFinal: true as const, transaction: row };
      }

      const lockedAmount = row.amount;
      const meta = (row.metaData as Prisma.JsonObject) ?? {};
      const rewardBefore =
        typeof meta.rewardBalanceBefore === "number"
          ? meta.rewardBalanceBefore
          : 0;

      const { fiat } = await this.ensureWalletWithFiat(tx, userId);

      let nextMeta: Prisma.JsonObject = {
        ...meta,
        vendorResponse: vendorResponse as Prisma.JsonValue,
      };
      if (patchMeta) {
        patchMeta(nextMeta);
      }

      if (delivered) {
        const finalReward =
          successRewardBalanceOverride ??
          (typeof meta.finalRewardBalance === "number"
            ? meta.finalRewardBalance
            : fiat.rewardBalance);

        await tx.fiat.update({
          where: { id: fiat.id },
          data: {
            lockedBalance: { decrement: lockedAmount },
            rewardBalance: finalReward,
          },
        });

        const updated = await tx.transaction.update({
          where: { id: row.id },
          data: {
            status: TransactionStatus.success,
            metaData: nextMeta,
          },
        });
        return { alreadyFinal: false as const, transaction: updated };
      }

      await tx.fiat.update({
        where: { id: fiat.id },
        data: {
          lockedBalance: { decrement: lockedAmount },
          availableBalance: { increment: lockedAmount },
          rewardBalance: rewardBefore,
        },
      });

      const updated = await tx.transaction.update({
        where: { id: row.id },
        data: {
          status: TransactionStatus.failed,
          metaData: nextMeta,
        },
      });
      return { alreadyFinal: false as const, transaction: updated };
    });
  }

  /** Refund pending utility tx (e.g. thrown error after lock). */
  static async refundPendingUtilityTx(input: {
    userId: string;
    clientRequestId: string;
  }) {
    const { userId, clientRequestId } = input;
    return prisma.$transaction(async (tx) => {
      const row = await tx.transaction.findUnique({
        where: { clientRequestId },
      });
      if (!row || row.userId !== userId) return null;
      if (row.status !== TransactionStatus.pending) return row;

      const lockedAmount = row.amount;
      const meta = (row.metaData as Prisma.JsonObject) ?? {};
      const rewardBefore =
        typeof meta.rewardBalanceBefore === "number"
          ? meta.rewardBalanceBefore
          : 0;

      const { fiat } = await this.ensureWalletWithFiat(tx, userId);

      await tx.fiat.update({
        where: { id: fiat.id },
        data: {
          lockedBalance: { decrement: lockedAmount },
          availableBalance: { increment: lockedAmount },
          rewardBalance: rewardBefore,
        },
      });

      return tx.transaction.update({
        where: { id: row.id },
        data: {
          status: TransactionStatus.failed,
          message: "Aborted",
        },
      });
    });
  }

  /** Marketplace / escrow-style lock (available → locked) + pending tx. */
  static async lockFundsForOrder(input: {
    userId: string;
    amount: number;
    clientRequestId: string;
    metaData?: Prisma.JsonObject;
  }) {
    const { userId, amount, clientRequestId, metaData } = input;
    if (amount <= 0) throw new Error("Invalid amount");

    return prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findUnique({
        where: { clientRequestId },
      });
      if (existing) {
        return { idempotent: true as const, transaction: existing };
      }

      const { fiat } = await this.ensureWalletWithFiat(tx, userId);
      if (fiat.availableBalance < amount) {
        throw new Error("Insufficient balance");
      }

      await tx.fiat.update({
        where: { id: fiat.id },
        data: {
          availableBalance: { decrement: amount },
          lockedBalance: { increment: amount },
        },
      });

      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: "wallet",
          amount,
          status: TransactionStatus.pending,
          clientRequestId,
          transactionRef: this.generateTransactionRef(),
          metaData: metaData ?? {},
        },
      });

      return { idempotent: false as const, transaction };
    });
  }

  static async moveLockedToAvailableCredit(input: {
    userId: string;
    amount: number;
  }) {
    const { userId, amount } = input;
    if (amount <= 0) return;

    return prisma.$transaction(async (tx) => {
      const { fiat } = await this.ensureWalletWithFiat(tx, userId);
      await tx.fiat.update({
        where: { id: fiat.id },
        data: {
          lockedBalance: { decrement: amount },
          availableBalance: { increment: amount },
        },
      });
    });
  }

  static async creditAvailableBalance(input: {
    userId: string;
    amount: number;
  }) {
    const { userId, amount } = input;
    if (amount <= 0) return;

    return prisma.$transaction(async (tx) => {
      const { fiat } = await this.ensureWalletWithFiat(tx, userId);
      await tx.fiat.update({
        where: { id: fiat.id },
        data: { availableBalance: { increment: amount } },
      });
    });
  }

  static async createCreditTransaction(input: {
    userId: string;
    amount: number;
    type: string;
    status?: TransactionStatus;
    metaData?: Prisma.JsonObject;
    transactionRef?: string;
  }) {
    const { userId, amount, type, metaData, transactionRef } = input;
    const status = input.status ?? TransactionStatus.success;
    return prisma.transaction.create({
      data: {
        userId,
        type,
        amount,
        status,
        metaData: metaData ?? {},
        transactionRef: transactionRef ?? this.generateTransactionRef(),
      },
    });
  }

  /** Wallet → wallet: atomic transfer + transfer row + two tx rows (success). */
  static async executeInternalWalletTransfer(input: {
    senderId: string;
    receiverId: string;
    amount: number;
    clientRequestId: string;
    humanRef?: string;
    metaData?: Prisma.JsonObject;
  }) {
    const {
      senderId,
      receiverId,
      amount,
      clientRequestId,
      humanRef,
      metaData,
    } = input;

    if (amount <= 0) throw new Error("Invalid amount");
    if (senderId === receiverId) throw new Error("Invalid transfer");

    return prisma.$transaction(async (tx) => {
      const dup = await tx.transfer.findUnique({
        where: { clientRequestId },
      });
      if (dup) {
        return { idempotent: true as const, transfer: dup };
      }

      const senderFiat = (await this.ensureWalletWithFiat(tx, senderId)).fiat;
      const receiverFiat = (await this.ensureWalletWithFiat(tx, receiverId))
        .fiat;

      if (senderFiat.availableBalance < amount) {
        throw new Error("Insufficient balance");
      }

      await tx.fiat.update({
        where: { id: senderFiat.id },
        data: { availableBalance: { decrement: amount } },
      });
      await tx.fiat.update({
        where: { id: receiverFiat.id },
        data: { availableBalance: { increment: amount } },
      });

      const transfer = await tx.transfer.create({
        data: {
          senderId,
          receiverId,
          amount,
          status: TransferStatus.success,
          clientRequestId,
          humanRef: humanRef ?? null,
          mode: "wallet",
          metaData: metaData ?? {},
        },
      });

      const baseMeta = (meta: Prisma.JsonObject) => ({
        ...meta,
        finalAmountToPay: amount,
        productName: "Wallet Transfer",
        transactionID: humanRef,
      });

      await tx.transaction.create({
        data: {
          userId: senderId,
          transferId: transfer.id,
          type: "wallet",
          amount,
          status: TransactionStatus.success,
          clientRequestId,
          metaData: baseMeta({
            ...(metaData ?? {}),
            direction: "debit",
          }),
        },
      });

      await tx.transaction.create({
        data: {
          userId: receiverId,
          transferId: transfer.id,
          type: "wallet",
          amount,
          status: TransactionStatus.success,
          clientRequestId: null,
          metaData: baseMeta({
            ...(metaData ?? {}),
            direction: "credit",
            sharedClientRequestId: clientRequestId,
          }),
        },
      });

      return { idempotent: false as const, transfer };
    });
  }

  /** External withdrawal: lock fiat + transfer row + single debit tx (pending). */
  static async lockExternalWithdrawal(input: {
    userId: string;
    amount: number;
    clientRequestId: string;
    humanRef: string;
    paystackRecipient: string;
    transferId: string;
    metaData?: Prisma.JsonObject;
  }) {
    const {
      userId,
      amount,
      clientRequestId,
      humanRef,
      paystackRecipient,
      transferId,
      metaData,
    } = input;

    return prisma.$transaction(async (tx) => {
      const dup = await tx.transfer.findUnique({
        where: { clientRequestId },
      });
      if (dup) {
        return { idempotent: true as const, transfer: dup };
      }

      const { fiat } = await this.ensureWalletWithFiat(tx, userId);
      if (fiat.availableBalance < amount) {
        throw new Error("Insufficient balance");
      }

      await tx.fiat.update({
        where: { id: fiat.id },
        data: {
          availableBalance: { decrement: amount },
          lockedBalance: { increment: amount },
        },
      });

      const transfer = await tx.transfer.create({
        data: {
          id: transferId,
          senderId: userId,
          receiverId: null,
          amount,
          status: TransferStatus.processing,
          clientRequestId,
          humanRef,
          paystackRecipient,
          mode: "wallet",
          metaData: metaData ?? {},
        },
      });

      const trx = await tx.transaction.create({
        data: {
          id: transferId,
          userId,
          transferId: transfer.id,
          type: "wallet",
          amount,
          status: TransactionStatus.pending,
          clientRequestId,
          humanRef,
          transactionRef: transferId,
          metaData: {
            ...(metaData ?? {}),
            finalAmountToPay: amount,
            productName: "Wallet Transfer",
            direction: "debit",
            transactionID: humanRef,
          },
        },
      });

      return { transfer, transaction: trx };
    });
  }

  static async markExternalTransferAndTxFailed(input: {
    transferId: string;
    userId: string;
    providerResponse?: unknown;
  }) {
    const { transferId, userId, providerResponse } = input;

    return prisma.$transaction(async (tx) => {
      const transfer = await tx.transfer.findUnique({
        where: { id: transferId },
      });
      if (!transfer || transfer.senderId !== userId) {
        throw new Error("Transfer not found");
      }

      const trx = await tx.transaction.findFirst({
        where: { transferId: transfer.id, userId },
      });
      if (!trx) throw new Error("Transaction not found");

      const { fiat } = await this.ensureWalletWithFiat(tx, userId);
      const amount = transfer.amount;

      await tx.fiat.update({
        where: { id: fiat.id },
        data: {
          lockedBalance: { decrement: amount },
          availableBalance: { increment: amount },
        },
      });

      await tx.transfer.update({
        where: { id: transferId },
        data: {
          status: TransferStatus.failed,
          providerResponse: providerResponse as Prisma.InputJsonValue,
        },
      });

      await tx.transaction.update({
        where: { id: trx.id },
        data: { status: TransactionStatus.failed },
      });
    });
  }

  static async finalizeExternalTransferSuccess(input: { transferRef: string }) {
    const { transferRef } = input;

    return prisma.$transaction(async (tx) => {
      const transfer = await tx.transfer.findUnique({
        where: { id: transferRef },
      });
      if (!transfer?.senderId) {
        throw new Error("Transfer not found");
      }

      const userId = transfer.senderId;
      const amount = transfer.amount;
      const trx = await tx.transaction.findFirst({
        where: { transferId: transfer.id, userId },
      });
      if (!trx) throw new Error("Transaction not found");

      const { fiat } = await this.ensureWalletWithFiat(tx, userId);

      await tx.fiat.update({
        where: { id: fiat.id },
        data: {
          lockedBalance: { decrement: amount },
        },
      });

      await tx.transfer.update({
        where: { id: transferRef },
        data: { status: TransferStatus.success },
      });

      await tx.transaction.update({
        where: { id: trx.id },
        data: { status: TransactionStatus.success },
      });
    });
  }

  /** Legacy escrow helper — kept for callers using type "escrow". */
  static async createEscrow({
    userId,
    amount,
    metaData,
    clientRequestId,
    type,
  }: {
    userId: string;
    amount: number;
    metaData?: Prisma.JsonValue | null;
    clientRequestId: string;
    type: "escrow";
  }) {
    return prisma.$transaction(async (tx) => {
      const { fiat } = await this.ensureWalletWithFiat(tx, userId);

      if (fiat.availableBalance < amount) {
        throw new Error("Insufficient balance");
      }

      await tx.fiat.update({
        where: { id: fiat.id },
        data: {
          availableBalance: { decrement: amount },
          lockedBalance: { increment: amount },
        },
      });

      const transaction = await tx.transaction.create({
        data: {
          userId,
          type,
          amount,
          status: TransactionStatus.pending,
          clientRequestId,
          transactionRef: this.generateTransactionRef(),
          metaData:
            metaData === null || metaData === undefined ? undefined : metaData,
        },
      });

      return {
        status: true,
        transactionId: transaction.id,
      };
    });
  }

  static async releaseEscow({
    userId,
    amount,
    orderId,
  }: {
    userId: string;
    amount: number;
    orderId: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const { fiat } = await this.ensureWalletWithFiat(tx, userId);

      if (fiat.lockedBalance < amount) {
        throw new Error("Insufficient locked balance");
      }

      await tx.fiat.update({
        where: { id: fiat.id },
        data: {
          lockedBalance: { decrement: amount },
        },
      });

      const transaction = await tx.transaction.update({
        where: { orderId: orderId },
        data: { status: TransactionStatus.success },
      });

      return { status: true, transactionId: transaction.id };
    });
  }
}
