import { getAuth } from 'firebase-admin/auth';
import { prisma } from '../../../prisma';
import { hashOtp } from '../../../shared/utils/opt';


/**
 * POST /auth/verify-pin-otp
 * Authenticated. Verifies the OTP sent for PIN reset — does NOT change PIN yet.
 * Body: { otp }
 */
export const verifyPinOtp = async (req: any, res: any) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    const decoded = await getAuth().verifyIdToken(authHeader.replace('Bearer ', ''));
    const { otp } = req.body;

    if (!otp) return res.status(400).json({ message: 'OTP is required.' });

    const user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: { id: true, pinResetOtpHash: true, pinResetOtpExpiry: true },
    });

    if (!user?.pinResetOtpHash || !user.pinResetOtpExpiry) {
      return res.status(400).json({ message: 'No reset code was requested.' });
    }
    if (new Date() > user.pinResetOtpExpiry) {
      return res.status(400).json({ message: 'Code has expired. Please request a new one.' });
    }
    if (hashOtp(otp) !== user.pinResetOtpHash) {
      return res.status(401).json({ message: 'Invalid code.' });
    }

    return res.json({ verified: true });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};