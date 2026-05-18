import bcrypt from 'bcryptjs';
import { getAuth } from 'firebase-admin/auth';
import { prisma } from '../../../prisma';
import { hashOtp } from  '../../../shared/utils/opt';

/**
 * POST /auth/reset-pin
 * Authenticated. Verifies OTP again + sets new PIN hash.
 * Body: { otp, newPin }
 */
export const resetPin = async (req: any, res: any) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    const decoded = await getAuth().verifyIdToken(authHeader.replace('Bearer ', ''));
    const { otp, newPin } = req.body;

    if (!otp || !newPin) {
      return res.status(400).json({ message: 'otp and newPin are required.' });
    }
    if (!/^\d{4}$/.test(newPin)) {
      return res.status(400).json({ message: 'PIN must be exactly 4 digits.' });
    }

    const user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: { id: true, pinResetOtpHash: true, pinResetOtpExpiry: true },
    });

    if (!user?.pinResetOtpHash || !user.pinResetOtpExpiry) {
      return res.status(400).json({ message: 'No reset code was requested.' });
    }
    if (new Date() > user.pinResetOtpExpiry) {
      return res.status(400).json({ message: 'Code expired. Please restart the process.' });
    }
    if (hashOtp(otp) !== user.pinResetOtpHash) {
      return res.status(401).json({ message: 'Invalid code.' });
    }

    const newHash = await bcrypt.hash(newPin, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        transactionPinHash: newHash,
        pinResetOtpHash: null,    // clear OTP fields
        pinResetOtpExpiry: null,
      },
    });

    return res.json({ message: 'Transaction PIN updated successfully.' });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};