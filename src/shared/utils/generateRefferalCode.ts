import { customAlphabet } from "nanoid";

const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

/**
 * Generates a unique, human-readable referral code e.g. "KF7X2QPM"
 */
export const generateReferralCode = (): string => `AM - ${nanoid()}`;