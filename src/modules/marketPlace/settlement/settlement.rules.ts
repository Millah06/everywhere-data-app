// src/modules/marketPlace/settlement/settlement.rules.ts
//
// PHASE 4 — Merchant Trust System
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for what each trust level is allowed to do:
//   • how long escrow is held before auto-release (settlementDelayHours)
//   • how much the merchant may withdraw per day (dailyWithdrawalLimit)
//   • whether the merchant may sell at all (canSell)
//
// These values are mirrored onto MerchantTrustProfile.settlementDelayHours /
// dailyWithdrawalLimit whenever a level changes (by trust.controller or
// trust.cron), so the rest of the system can read a cheap, stable column
// instead of recomputing rules. This file is the ONLY place the numbers live.
//
// IMPORTANT (migration safety): the MerchantTrustProfile table ships in the
// GATED phase1_foundation migration. Until that migration is applied to the DB,
// `getVendorSettlementDelayHours()` and `getVendorTrustLevel()` FAIL OPEN — they
// fall back to AppConfig.autoReleaseHours / level 1 so existing ordering and
// existing approved sellers keep working untouched. Once the migration lands,
// they automatically start honouring the real profile.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../../../prisma";

export type TrustLevel = 0 | 1 | 2 | 3;

export interface SettlementRule {
  /** Hours escrow is held before auto-release. Infinity = never auto-release. */
  delayHours: number;
  /** Naira a merchant may withdraw per day. Infinity = unlimited. */
  dailyLimit: number;
  /** Whether the merchant is allowed to receive orders / appear in search. */
  canSell: boolean;
}

// Spec §11 table. `Infinity` is intentional and used for the canSell / unlimited
// SEMANTICS. For DB persistence we clamp to finite values (see *ForDb helpers),
// because Postgres Float/Int columns cannot store Infinity.
export const SETTLEMENT_RULES: Record<TrustLevel, SettlementRule> = {
  0: { delayHours: Infinity, dailyLimit: 0, canSell: false },
  1: { delayHours: 48, dailyLimit: 50_000, canSell: true },
  2: { delayHours: 24, dailyLimit: 200_000, canSell: true },
  3: { delayHours: 0, dailyLimit: Infinity, canSell: true },
};

// Finite sentinels for DB columns.
// • Level 0 has no orders (canSell:false), so its delay never actually fires a
//   timer — we store a very large finite value purely so the column is valid.
// • Level 3 is "unlimited" withdrawal — stored as a large finite number the UI
//   renders as "Unlimited".
const L0_DELAY_HOURS_DB = 24 * 365 * 10; // ~10 years; effectively "never"
const UNLIMITED_DAILY_DB = 1_000_000_000_000; // 1e12 — UI shows "Unlimited"

export const UNLIMITED_DAILY_LIMIT = UNLIMITED_DAILY_DB;

export function rulesForLevel(level: number): SettlementRule {
  const lvl = clampLevel(level);
  return SETTLEMENT_RULES[lvl];
}

export function clampLevel(level: number): TrustLevel {
  if (level <= 0) return 0;
  if (level === 1) return 1;
  if (level === 2) return 2;
  return 3;
}

/** Settlement delay as a DB-safe finite integer for the given level. */
export function settlementDelayHoursForDb(level: number): number {
  const rule = rulesForLevel(level);
  return Number.isFinite(rule.delayHours) ? rule.delayHours : L0_DELAY_HOURS_DB;
}

/** Daily withdrawal limit as a DB-safe finite number for the given level. */
export function dailyWithdrawalLimitForDb(level: number): number {
  const rule = rulesForLevel(level);
  return Number.isFinite(rule.dailyLimit) ? rule.dailyLimit : UNLIMITED_DAILY_DB;
}

export function canSellAtLevel(level: number): boolean {
  return rulesForLevel(level).canSell;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime helpers used by the order flow. ALL are fail-open by design.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a vendor's current trust level from the stored profile.
 * Fail-open: if the trust table/profile is absent (pre-migration, or an
 * un-seeded vendor) we treat the vendor as level 1 (the level all existing
 * approved sellers are seeded to) so nothing locks out.
 */
export async function getVendorTrustLevel(vendorId: string): Promise<number> {
  try {
    const profile = await prisma.merchantTrustProfile.findUnique({
      where: { vendorId },
      select: { level: true },
    });
    return profile?.level ?? 1;
  } catch {
    // Table not migrated yet → behave as before the trust system existed.
    return 1;
  }
}

/**
 * Resolve the settlement (escrow auto-release) delay in hours for a vendor.
 * Reads MerchantTrustProfile.settlementDelayHours (kept in sync with the level).
 * Fail-open: falls back to AppConfig.autoReleaseHours, then to 24h — exactly the
 * old behaviour — if the profile/table is missing. This is what the escrow timer
 * in placeOrder/cancelAppeal calls so it can be deployed safely BEFORE the gated
 * migration and start honouring trust automatically after it.
 */
export async function getVendorSettlementDelayHours(
  vendorId: string,
): Promise<number> {
  try {
    const profile = await prisma.merchantTrustProfile.findUnique({
      where: { vendorId },
      select: { settlementDelayHours: true },
    });
    if (profile && typeof profile.settlementDelayHours === "number") {
      return profile.settlementDelayHours;
    }
  } catch {
    // fall through to legacy behaviour
  }
  const config = await prisma.appConfig.findFirst();
  return config?.autoReleaseHours ?? 24;
}

/**
 * Ensure a MerchantTrustProfile exists for a vendor, creating one at level 0 if
 * not. Returns the profile. Used by the trust controller/cron. NOT called from
 * the hot order path (that path stays fail-open and never creates rows).
 */
export async function ensureTrustProfile(vendorId: string) {
  const existing = await prisma.merchantTrustProfile.findUnique({
    where: { vendorId },
  });
  if (existing) return existing;
  return prisma.merchantTrustProfile.create({
    data: {
      vendorId,
      level: 0,
      settlementDelayHours: settlementDelayHoursForDb(0),
      dailyWithdrawalLimit: dailyWithdrawalLimitForDb(0),
    },
  });
}