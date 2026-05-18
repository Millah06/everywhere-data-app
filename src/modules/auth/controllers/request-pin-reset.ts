import { getAuth } from 'firebase-admin/auth';
import { prisma } from '../../../prisma';
import { generateOtp, hashOtp, otpExpiresAt } from  '../../../shared/utils/opt';

/**
 * POST /auth/request-pin-reset
 * Authenticated. Generates OTP, stores hash, sends to user's email.
 * Accepts { preview: true } to return maskedEmail without sending.
 */
export const requestPinReset = async (req: any, res: any) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    const decoded = await getAuth().verifyIdToken(
      authHeader.replace('Bearer ', '')
    );

    const user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: { id: true, email: true },
    });
    if (!user) return res.status(404).json({ message: 'User not found.' });

    // Mask email for display: john@gmail.com → j***@gmail.com
    const [name, domain] = user.email.split('@');
    const maskedEmail = `${name[0]}${'*'.repeat(Math.max(name.length - 1, 3))}@${domain}`;

    // preview=true → just return the masked email, don't send OTP
    if (req.body?.preview) {
      return res.json({ maskedEmail });
    }

    // Rate limit: block if an OTP was sent in the last 60 seconds
    const existing = await prisma.user.findUnique({
      where: { id: user.id },
      select: { pinResetOtpExpiry: true },
    });
    if (existing?.pinResetOtpExpiry) {
      const secondsLeft = (existing.pinResetOtpExpiry.getTime() - Date.now()) / 1000;
      if (secondsLeft > 540) { // still within first 60s of the 10-min window
        return res.status(429).json({ message: 'Please wait before requesting another code.' });
      }
    }

    const otp = generateOtp();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        pinResetOtpHash: hashOtp(otp),
        pinResetOtpExpiry: otpExpiresAt(10),
      },
    });

    // ─── Email Sending ──────────────────────────────────────────────────────
    // PLACEHOLDER — activate when you have a domain + Resend account.
    //
    // SETUP GUIDE (takes ~10 minutes once you have a domain):
    // 1. Sign up at https://resend.com  (100 free emails/day, no CC needed)
    // 2. Go to Domains → Add Domain → follow the 3 DNS record instructions
    //    (SPF, DKIM, DMARC — your domain registrar's DNS panel)
    // 3. Get API key from https://resend.com/api-keys
    // 4. Add to .env:  RESEND_API_KEY=re_xxxxxxxxxxxx
    // 5. Run: npm install resend
    // 6. Uncomment below & delete the console.log line
    //
    // import { Resend } from 'resend';
    // const resend = new Resend(process.env.RESEND_API_KEY);
    // await resend.emails.send({
    //   from: 'Amril <security@yourdomain.com>',
    //   to: user.email,
    //   subject: 'Your PIN reset code',
    //   html: `
    //     <div style="font-family:sans-serif;max-width:480px">
    //       <h2 style="color:#21D3ED">PIN Reset Code</h2>
    //       <p>Use this code to reset your transaction PIN:</p>
    //       <p style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#0F172A;
    //                  background:#f0fdff;padding:16px;border-radius:8px;text-align:center">
    //         ${otp}
    //       </p>
    //       <p style="color:#666">Expires in 10 minutes. Do not share this code.</p>
    //     </div>`,
    // });

    // DEV ONLY — remove before production:
    console.log(`[DEV] PIN reset OTP for ${user.email}: ${otp}`);

    return res.json({ maskedEmail });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};