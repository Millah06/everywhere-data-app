import * as admin from 'firebase-admin';

const db = admin.firestore();

/**
 * Get user's available wallet balance
 */
export const getWalletBalance = async (userId: string) => {
  const userRef = db.collection('users').doc(userId);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    throw new Error('User not found');
  }

  return userSnap.data()?.wallet?.fiat?.availableBalance ?? 0;
};


/**
 * Credit user's available balance
 */
export const creditWallet = async (
  userId: string,
  amount: number
) => {
  if (amount <= 0) {
    throw new Error('Amount must be greater than zero');
  }

  const userRef = db.collection('users').doc(userId);

  const newBalance = await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      throw new Error('User not found');
    }

    const currentBalance =
      userSnap.data()?.wallet?.fiat?.availableBalance ?? 0;

    const updatedBalance = currentBalance + amount;

    transaction.update(userRef, {
      'wallet.fiat.availableBalance': updatedBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return updatedBalance;
  });

  return newBalance;
};


/**
 * Deduct from user's available balance
 */
export const deductWallet = async (
  userId: string,
  amount: number
) => {
  if (amount <= 0) {
    throw new Error('Amount must be greater than zero');
  }

  const userRef = db.collection('users').doc(userId);

  const newBalance = await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      throw new Error('User not found');
    }

    const currentBalance =
      userSnap.data()?.wallet?.fiat?.availableBalance ?? 0;

    if (currentBalance < amount) {
      throw new Error('Insufficient balance');
    }

    const updatedBalance = currentBalance - amount;

    transaction.update(userRef, {
      'wallet.fiat.availableBalance': updatedBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return updatedBalance;
  });

  return newBalance;
};
