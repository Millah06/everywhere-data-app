import { getAuth } from 'firebase-admin/auth';
import { prisma } from '../../../prisma';
import { hashOtp } from  '../../../shared/utils/opt';

/**
 * POST /auth/reset-password
 * PUBLIC — no auth token.
 * Body: { email, otp, newPassword }
 */
export const resetPassword = async (req: any, res: any) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: 'email, otp, and newPassword are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: {
        id: true,
        firebaseUid: true,
        passwordResetOtpHash: true,
        passwordResetOtpExpiry: true,
      },
    });

    if (!user?.passwordResetOtpHash || !user.passwordResetOtpExpiry) {
      return res.status(400).json({ message: 'No reset was requested for this email.' });
    }
    if (new Date() > user.passwordResetOtpExpiry) {
      return res.status(400).json({ message: 'Code has expired. Please start again.' });
    }
    if (hashOtp(otp) !== user.passwordResetOtpHash) {
      return res.status(401).json({ message: 'Invalid code.' });
    }

    // Update password in Firebase (Admin SDK handles the actual credential)
    await getAuth().updateUser(user.firebaseUid, { password: newPassword });

    // Clear OTP fields
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetOtpHash: null,
        passwordResetOtpExpiry: null,
      },
    });

    return res.json({ message: 'Password updated successfully.' });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};