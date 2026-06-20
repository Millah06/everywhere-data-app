// src/modules/auth/controllers/request-email-verification.ts
//
// PHASE 13 — Email verification (request code).
// ─────────────────────────────────────────────────────────────────────────────
// Authenticated. Mirrors request-pin-reset.ts EXACTLY (same opt.ts helpers, same
// Resend placeholder, same dev console.log). Email verification is the free
// Level-0 account-ownership step — it grants NO badge and unlocks no cash-out.
// ─────────────────────────────────────────────────────────────────────────────

import { getAuth } from "firebase-admin/auth";
import { prisma } from "../../../prisma";
import { generateOtp, hashOtp, otpExpiresAt } from "../../../shared/utils/opt";

/**
 * POST /auth/request-email-verification
 * Authenticated. Generates a 6-digit OTP, stores its hash, "sends" it to the
 * user's email. Accepts { preview: true } to return maskedEmail without sending.
 */
export const requestEmailVerification = async (req: any, res: any) => {
  try {
    const authHeader = req.headers.authorization ?? "";
    const decoded = await getAuth().verifyIdToken(
      authHeader.replace("Bearer ", ""),
    );

    const user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: { id: true, email: true, emailVerified: true },
    });
    if (!user) return res.status(404).json({ message: "User not found." });
    if (user.emailVerified) {
      return res.json({ alreadyVerified: true, message: "Email already verified." });
    }

    const [name, domain] = user.email.split("@");
    const maskedEmail = `${name[0]}${"*".repeat(Math.max(name.length - 1, 3))}@${domain}`;

    if (req.body?.preview) return res.json({ maskedEmail });

    // Rate limit: block a repeat send inside the first 60s of the 10-min window.
    const existing = await prisma.user.findUnique({
      where: { id: user.id },
      select: { emailVerifyOtpExpiry: true },
    });
    if (existing?.emailVerifyOtpExpiry) {
      const secondsLeft =
        (existing.emailVerifyOtpExpiry.getTime() - Date.now()) / 1000;
      if (secondsLeft > 540) {
        return res
          .status(429)
          .json({ message: "Please wait before requesting another code." });
      }
    }

    const otp = generateOtp();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifyOtpHash: hashOtp(otp),
        emailVerifyOtpExpiry: otpExpiresAt(10),
      },
    });

    // ─── Email Sending (same Resend setup as request-pin-reset.ts) ──────────
    // Uncomment once RESEND_API_KEY + a verified domain are configured:
    //
    // import { Resend } from 'resend';
    // const resend = new Resend(process.env.RESEND_API_KEY);
    // await resend.emails.send({
    //   from: 'Amril <security@yourdomain.com>',
    //   to: user.email,
    //   subject: 'Verify your Amril email',
    //   html: `
    //     <div style="font-family:sans-serif;max-width:480px">
    //       <h2 style="color:#21D3ED">Verify your email</h2>
    //       <p>Enter this code in the app to confirm your email:</p>
    //       <p style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#0F172A;
    //                  background:#f0fdff;padding:16px;border-radius:8px;text-align:center">
    //         ${otp}
    //       </p>
    //       <p style="color:#666">Expires in 10 minutes. Do not share this code.</p>
    //     </div>`,
    // });

    // DEV ONLY — remove before production:
    console.log(`[DEV] Email verification OTP for ${user.email}: ${otp}`);

    return res.json({ maskedEmail });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};