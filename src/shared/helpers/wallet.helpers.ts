import { prisma } from "../../prisma";

/**
 * Read available fiat balance for a user (Prisma User.id).
 */
export const getWalletBalance = async (userId: string): Promise<number> => {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    include: { fiat: true },
  });
  if (!wallet?.fiat) {
    throw new Error("User not found");
  }
  return wallet.fiat.availableBalance;
};

export const creditWallet = async (userId: string, amount: number) => {
  if (amount <= 0) {
    throw new Error("Amount must be greater than zero");
  }
  await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({
      where: { userId },
      include: { fiat: true },
    });
    if (!wallet?.fiat) throw new Error("User not found");
    await tx.fiat.update({
      where: { id: wallet.fiat.id },
      data: { availableBalance: { increment: amount } },
    });
  });
  const w = await prisma.wallet.findUnique({
    where: { userId },
    include: { fiat: true },
  });
  return w?.fiat?.availableBalance ?? 0;
};

export const deductWallet = async (userId: string, amount: number) => {
  if (amount <= 0) {
    throw new Error("Amount must be greater than zero");
  }
  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({
      where: { userId },
      include: { fiat: true },
    });
    if (!wallet?.fiat) throw new Error("User not found");
    const current = wallet.fiat.availableBalance;
    if (current < amount) {
      throw new Error("Insufficient balance");
    }
    await tx.fiat.update({
      where: { id: wallet.fiat.id },
      data: { availableBalance: { decrement: amount } },
    });
    return current - amount;
  });
};

export const creditWalletTransactional = async (
  userId: string,
  amount: number,
) => {
  return creditWallet(userId, amount);
};

export const deductWalletTransactional = async (
  userId: string,
  amount: number,
) => {
  return deductWallet(userId, amount);
};
