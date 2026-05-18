import { prisma } from '../../../prisma';
import { generateOtp, hashOtp, otpExpiresAt } from '../../../shared/utils/opt';

/**
 * POST /auth/request-password-reset
 * PUBLIC — no auth token (user is locked out).
 * Body: { email }
 */
export const requestPasswordReset = async (req: any, res: any) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true, email: true },
    });

    // Always return success to prevent email enumeration attacks
    if (!user) return res.json({ message: 'If an account exists, a code has been sent.' });

    const otp = generateOtp();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetOtpHash: hashOtp(otp),
        passwordResetOtpExpiry: otpExpiresAt(10),
      },
    });

    // ─── Email Sending Placeholder (same Resend setup as request-pin-reset) ──
    // See request-pin-reset.ts for the full setup guide.
    //
    // await resend.emails.send({
    //   from: 'Amril <security@yourdomain.com>',
    //   to: user.email,
    //   subject: 'Reset your Amril password',
    //   html: `...${otp}...`,
    // });

    console.log(`[DEV] Password reset OTP for ${user.email}: ${otp}`);

    return res.json({ message: 'If an account exists, a code has been sent.' });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};