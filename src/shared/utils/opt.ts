import crypto from 'crypto'; // built-in Node.js — no install needed

/** Generates a cryptographically random 6-digit OTP string. */
export function generateOtp(): string {
  // crypto.randomInt is uniform — no modulo bias
  return crypto.randomInt(100000, 999999).toString();
}

/** SHA-256 hash of the OTP — safe to store in DB. */
export function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

export function otpExpiresAt(minutes = 10): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}