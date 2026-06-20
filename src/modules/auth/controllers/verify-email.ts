// src/modules/auth/controllers/verify-email.ts
//
// PHASE 13 — Email verification (confirm code).
// ─────────────────────────────────────────────────────────────────────────────
// Authenticated. Same OTP check as verify-pin-otp. On success flips
// User.emailVerified = true and clears the OTP fields.
// ─────────────────────────────────────────────────────────────────────────────

import { getAuth } from "firebase-admin/auth";
import { prisma } from "../../../prisma";
import { hashOtp } from "../../../shared/utils/opt";

/**
 * POST /auth/verify-email
 * Authenticated. Body: { otp }
 */
export const verifyEmail = async (req: any, res: any) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ message: "otp is required." });

    const authHeader = req.headers.authorization ?? "";
    const decoded = await getAuth().verifyIdToken(
      authHeader.replace("Bearer ", ""),
    );

    const user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: {
        id: true,
        emailVerifyOtpHash: true,
        emailVerifyOtpExpiry: true,
        emailVerified: true,
      },
    });
    if (!user) return res.status(404).json({ message: "User not found." });
    if (user.emailVerified) {
      return res.json({ verified: true, message: "Email already verified." });
    }
    if (!user.emailVerifyOtpHash || !user.emailVerifyOtpExpiry) {
      return res
        .status(400)
        .json({ message: "No verification was requested. Request a code first." });
    }
    if (new Date() > user.emailVerifyOtpExpiry) {
      return res
        .status(400)
        .json({ message: "Code has expired. Please request a new one." });
    }
    if (hashOtp(otp) !== user.emailVerifyOtpHash) {
      return res.status(401).json({ message: "Invalid code." });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerifyOtpHash: null,
        emailVerifyOtpExpiry: null,
      },
    });

    return res.json({ verified: true, message: "Email verified." });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};