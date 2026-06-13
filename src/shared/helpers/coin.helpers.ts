// src/shared/helpers/coin.helpers.ts
//
// PHASE 10 — Coin economy ledger helper.
//
// This is the SINGLE place that knows the purchased/earned invariant. Every coin
// mutation (gift, boost, purchase credit, conversion) goes through here so the
// rules can never drift between controllers:
//
//   • purchasedCoins  — bought via Apple IAP / Google Play / NG wallet.
//                       SPEND-ONLY. They can gift, boost, or buy digital content.
//                       They can NEVER be converted to wallet money. (No buy→cash
//                       round-trip → no self-remittance / FX exposure.)
//   • earnedCoins     — received as gifts. These form the creator-earnings ledger.
//                       ONLY these convert to wallet balance, and ONLY for NG-tied
//                       users. Non-NG creators can re-gift them onward until they
//                       reach someone who can convert.
//
// Spend order is ALWAYS purchased-first, then earned. Spending a user's own
// purchased coins before their earned coins means earned coins tend to flow
// onward as gifts (matching the contract), and a user's convertible balance is
// only ever reduced by an explicit conversion — never silently by gifting.
//
// `balance` (the legacy single-pool column) is kept in sync as
// purchasedCoins + earnedCoins on every mutation, so any old read path that
// still looks at `balance` keeps working until it is migrated/removed.

import { prisma } from "../../prisma";
import type { Prisma } from "@prisma/client";

// A Prisma transaction client OR the root client — every function accepts either,
// so callers can compose these inside a larger `$transaction`.
type Db = Prisma.TransactionClient | typeof prisma;

// ── Rate config ───────────────────────────────────────────────────────────────
// Defaults match the historical ₦1 = 10 coins. Both rates are admin-editable via
// AppConfig (no app release needed). coinConversionRate is the cash-out lever:
// raising it above the purchase rate is the platform's FX/earnings spread.
const DEFAULT_PURCHASE_RATE_NGN = 10; // coins per ₦1 when buying with the NG wallet
const DEFAULT_CONVERSION_RATE = 10; // earned coins per ₦1 when cashing out

export async function getCoinRates(db: Db = prisma): Promise<{
  purchaseRateNgn: number;
  conversionRate: number;
}> {
  // AppConfig is a singleton row; read defensively so a missing column (pre-migrate)
  // falls back to code defaults rather than throwing.
  try {
    const cfg = await db.appConfig.findUnique({ where: { id: "singleton" } });
    return {
      purchaseRateNgn:
        (cfg as any)?.coinPurchaseRateNgn ?? DEFAULT_PURCHASE_RATE_NGN,
      conversionRate: (cfg as any)?.coinConversionRate ?? DEFAULT_CONVERSION_RATE,
    };
  } catch {
    return {
      purchaseRateNgn: DEFAULT_PURCHASE_RATE_NGN,
      conversionRate: DEFAULT_CONVERSION_RATE,
    };
  }
}

export const coinsToNaira = (coins: number, rate: number): number =>
  rate > 0 ? coins / rate : 0;
export const nairaToCoins = (naira: number, rate: number): number =>
  Math.floor(naira * rate);

// ── Region gate (mirror of the Flutter RegionProvider rule, kept identical) ────
// NG-tied = phone starts +234 OR country == 'NG' OR country missing (legacy → NG).
// Phone is checked first and independently so a +234 diaspora user on a foreign
// country code is still treated as NG-tied.
export function isNgTied(user: {
  phone?: string | null;
  country?: string | null;
}): boolean {
  const phone = (user.phone ?? "").replace(/\s+/g, "");
  if (phone.startsWith("+234") || phone.startsWith("234")) return true;
  const country = (user.country ?? "").toUpperCase();
  if (country === "") return true; // legacy rows with no country → NG
  return country === "NG";
}

// ── Ledger reads ───────────────────────────────────────────────────────────────
export interface CoinLedger {
  purchasedCoins: number;
  earnedCoins: number;
  balance: number; // purchasedCoins + earnedCoins (kept in sync)
  totalEarned: number;
  totalSpent: number;
  totalPurchased: number;
}

/** Returns the user's ledger, creating a zeroed row on first read. */
export async function getOrCreateLedger(
  db: Db,
  userId: string,
): Promise<CoinLedger> {
  const row = await db.userCoins.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  return {
    purchasedCoins: (row as any).purchasedCoins ?? 0,
    earnedCoins: (row as any).earnedCoins ?? row.balance ?? 0,
    balance: row.balance ?? 0,
    totalEarned: row.totalEarned ?? 0,
    totalSpent: row.totalSpent ?? 0,
    totalPurchased: (row as any).totalPurchased ?? 0,
  };
}

/** Spendable total = purchased + earned (both can pay for gifts/boosts). */
export function spendable(l: CoinLedger): number {
  return l.purchasedCoins + l.earnedCoins;
}

// ── Mutations ────────────────────────────────────────────────────────────────

/**
 * Spend `coins` from a user, purchased-first then earned.
 * Throws if the user does not have enough spendable coins.
 * Returns how the spend was split (useful for analytics / receipts).
 * MUST be called inside a transaction (`db` = tx client) by gift/boost.
 */
export async function spendCoins(
  db: Db,
  userId: string,
  coins: number,
): Promise<{ fromPurchased: number; fromEarned: number }> {
  if (coins <= 0) throw new Error("Spend amount must be positive");

  const l = await getOrCreateLedger(db, userId);
  if (spendable(l) < coins) {
    const err: any = new Error("INSUFFICIENT_COINS");
    err.code = "INSUFFICIENT_COINS";
    err.available = spendable(l);
    throw err;
  }

  const fromPurchased = Math.min(l.purchasedCoins, coins);
  const fromEarned = coins - fromPurchased;

  const newPurchased = l.purchasedCoins - fromPurchased;
  const newEarned = l.earnedCoins - fromEarned;

  await db.userCoins.update({
    where: { userId },
    data: {
      purchasedCoins: newPurchased,
      earnedCoins: newEarned,
      balance: newPurchased + newEarned, // keep legacy column coherent
      totalSpent: { increment: coins },
    },
  });

  return { fromPurchased, fromEarned };
}

/**
 * Credit purchased (spend-only) coins — from a verified IAP receipt or an NG
 * wallet purchase. These can never be converted.
 */
export async function creditPurchasedCoins(
  db: Db,
  userId: string,
  coins: number,
): Promise<void> {
  if (coins <= 0) return;
  const l = await getOrCreateLedger(db, userId);
  const newPurchased = l.purchasedCoins + coins;
  await db.userCoins.update({
    where: { userId },
    data: {
      purchasedCoins: newPurchased,
      balance: newPurchased + l.earnedCoins,
      totalPurchased: { increment: coins },
    },
  });
}

/**
 * Credit earned (convertible) coins — the creator-payout ledger, written when a
 * gift is received.
 */
export async function creditEarnedCoins(
  db: Db,
  userId: string,
  coins: number,
): Promise<void> {
  if (coins <= 0) return;
  const l = await getOrCreateLedger(db, userId);
  const newEarned = l.earnedCoins + coins;
  await db.userCoins.update({
    where: { userId },
    data: {
      earnedCoins: newEarned,
      balance: l.purchasedCoins + newEarned,
      totalEarned: { increment: coins },
    },
  });
}

/**
 * Remove earned coins on conversion (cash-out). Throws if the user is not
 * NG-tied or does not have enough EARNED coins. purchasedCoins is never touched.
 */
export async function debitEarnedForConversion(
  db: Db,
  userId: string,
  coins: number,
): Promise<void> {
  const l = await getOrCreateLedger(db, userId);
  if (l.earnedCoins < coins) {
    const err: any = new Error("INSUFFICIENT_EARNED_COINS");
    err.code = "INSUFFICIENT_EARNED_COINS";
    err.available = l.earnedCoins;
    throw err;
  }
  const newEarned = l.earnedCoins - coins;
  await db.userCoins.update({
    where: { userId },
    data: {
      earnedCoins: newEarned,
      balance: l.purchasedCoins + newEarned,
    },
  });
}