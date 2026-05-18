// src/features/auth/controllers/pin.ts
import bcrypt from 'bcryptjs';
import { getAuth } from 'firebase-admin/auth';
import { prisma } from '../../../prisma';

/** POST /auth/set-pin — Called once during SecurityScreen setup */
export const setTransactionPin = async (req: any, res: any) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    const decoded = await getAuth().verifyIdToken(authHeader.replace('Bearer ', ''));

    const { pin } = req.body;
    if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ message: 'PIN must be exactly 4 digits.' });
    }

    const hash = await bcrypt.hash(pin, 12);
    await prisma.user.update({
      where: { firebaseUid: decoded.uid },
      data: { transactionPinHash: hash },
    });

    return res.json({ message: 'PIN set successfully.' });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/** POST /auth/verify-pin — Called before any financial operation */
export const verifyTransactionPin = async (req: any, res: any) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    const decoded = await getAuth().verifyIdToken(authHeader.replace('Bearer ', ''));

    const { pin } = req.body;
    const user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: { transactionPinHash: true },
    });

    if (!user?.transactionPinHash) {
      return res.status(404).json({ message: 'PIN not set. Please set a transaction PIN.',  code: 'pin_not_set',  });
    }

    const isValid = await bcrypt.compare(pin, user.transactionPinHash);
    if (!isValid) {
      return res.status(401).json({ message: 'Incorrect PIN.', code: 'incorrect_pin' });
    }

    // Issue a short-lived "pin_verified" claim the client attaches to the withdrawal request
    // OR just return a signed JWT the client sends with the financial request:
    return res.json({ verified: true });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};