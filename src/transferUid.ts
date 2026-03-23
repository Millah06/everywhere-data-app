import { customAlphabet } from "nanoid";

const nanoid = customAlphabet("23456789", 8);

/**
 * Generates a unique, human-readable referral code e.g. "KF7X2QPM"
 */
export const generate11DigitId = (): string => `1${nanoid()}`;