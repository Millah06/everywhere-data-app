// src/modules/payment/payment.types.ts
//
// Shared vocabulary for the payment engine. Nothing here touches the DB or any
// provider — it is the single place where the engine's *contract* lives so the
// controller, handler, providers, recovery job and the Flutter client all agree
// on the same strings and the same legal state transitions.
//
// IMPORTANT (additive): the Prisma `PaymentStatus` enum (CREATED PENDING
// VERIFYING SUCCESS FAILED EXPIRED REFUNDED) was added in the Phase 1
// `phase1_foundation` migration. We mirror it here as a const map so callers
// don't have to import the generated Prisma enum everywhere, and so the state
// machine can be reasoned about in one file.

import type { PaymentStatus as PrismaPaymentStatus } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Status — kept string-identical to the Prisma enum members.
// ─────────────────────────────────────────────────────────────────────────────
export const PAYMENT_STATUS = {
  CREATED: "CREATED",
  PENDING: "PENDING",
  VERIFYING: "VERIFYING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
  REFUNDED: "REFUNDED",
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

// Terminal states never transition again (except SUCCESS → REFUNDED).
export const TERMINAL_STATUSES: PaymentStatus[] = [
  PAYMENT_STATUS.SUCCESS,
  PAYMENT_STATUS.FAILED,
  PAYMENT_STATUS.EXPIRED,
  PAYMENT_STATUS.REFUNDED,
];

// Legal transitions (spec §12). Anything not listed is rejected by
// `assertTransition`, which protects against e.g. a late webhook flipping an
// already-FAILED payment to SUCCESS, or double-crediting a SUCCESS payment.
const ALLOWED: Record<PaymentStatus, PaymentStatus[]> = {
  CREATED: [
    PAYMENT_STATUS.PENDING, // OPay cashier created
    PAYMENT_STATUS.SUCCESS, // wallet executes inline
    PAYMENT_STATUS.FAILED, // wallet insufficient / provider create failed
    PAYMENT_STATUS.EXPIRED, // sat in CREATED > 30 min
  ],
  PENDING: [
    PAYMENT_STATUS.VERIFYING, // webhook/poll triggered a provider re-query
    PAYMENT_STATUS.SUCCESS,
    PAYMENT_STATUS.FAILED,
    PAYMENT_STATUS.EXPIRED,
  ],
  VERIFYING: [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.FAILED, PAYMENT_STATUS.PENDING],
  SUCCESS: [PAYMENT_STATUS.REFUNDED],
  FAILED: [], // dead — client must create a fresh Payment to retry
  EXPIRED: [],
  REFUNDED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return true; // idempotent re-writes are harmless
  return (ALLOWED[from] ?? []).includes(to);
}

/** Throws if `from → to` is not a legal move. Use before any status write. */
export function assertTransition(
  from: PrismaPaymentStatus | PaymentStatus,
  to: PaymentStatus,
): void {
  if (!canTransition(from as PaymentStatus, to)) {
    throw new Error(`Illegal payment transition ${from} → ${to}`);
  }
}

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// ─────────────────────────────────────────────────────────────────────────────
// Providers — the engine is provider-agnostic; these are the ones wired today.
// ─────────────────────────────────────────────────────────────────────────────
export const PAYMENT_PROVIDER = {
  WALLET: "wallet",
  OPAY: "opay",
} as const;
export type PaymentProvider =
  (typeof PAYMENT_PROVIDER)[keyof typeof PAYMENT_PROVIDER];

// ─────────────────────────────────────────────────────────────────────────────
// Entity types — what a Payment is *for*. The handler dispatches on this. New
// services register their own handler under a new entityType (see
// payment.handler.ts) without changing the engine.
// ─────────────────────────────────────────────────────────────────────────────
export const PAYMENT_ENTITY = {
  MARKETPLACE_ORDER: "marketplace_order",
  UTILITY: "utility",
  DINE_IN_ORDER: "dine_in_order",
} as const;
export type PaymentEntity =
  (typeof PAYMENT_ENTITY)[keyof typeof PAYMENT_ENTITY];

// CREATED payments expire after this long with no progress (spec §13.3).
export const PAYMENT_EXPIRY_MINUTES = 15;

// How long an OPay cashier session stays open, in seconds (spec: 30 min view,
// but OPay's `expireAt` is its own window — we keep them aligned).
export const OPAY_SESSION_EXPIRY_SECONDS = PAYMENT_EXPIRY_MINUTES * 60;