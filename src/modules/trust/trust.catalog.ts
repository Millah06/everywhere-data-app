// src/modules/trust/trust.catalog.ts
//
// PHASE 4 — Merchant Trust System · Level Catalog
// ─────────────────────────────────────────────────────────────────────────────
// The SINGLE source of truth for how every trust level is *described* to
// merchants: its tagline, the requirements to reach it, and the benefits it
// unlocks. The Flutter app renders the comparison UI entirely from this — it
// hardcodes NOTHING about levels — so changing a benefit, a threshold, or a
// tagline here (one place) updates every client automatically.
//
// Numbers (settlement delay, daily limit, can-sell) are pulled from
// settlement.rules.ts; performance thresholds (order counts, dispute %, account
// age, fee) are passed in from trust.controller.ts. This file never re-declares
// a number that lives elsewhere — it composes them.
//
// RUNTIME / ADMIN OVERRIDES (no app release needed):
//   buildTrustLevelCatalog() accepts an optional `overrides` object. Pass the
//   JSON an admin edits (e.g. AppConfig.trustCatalog — see note at the bottom)
//   and the matching level's tagline / benefits / requirement labels are merged
//   over the code defaults. Anything not overridden falls back to the defaults
//   below, so partial overrides are safe.
// ─────────────────────────────────────────────────────────────────────────────

import {
  rulesForLevel,
  settlementDelayHoursForDb,
  dailyWithdrawalLimitForDb,
  UNLIMITED_DAILY_LIMIT,
} from "../marketPlace/settlement/settlement.rules";

// Re-stated from the model the controller computes, kept local to avoid a
// circular import (controller imports this file, not the other way around).
export interface CatalogStats {
  totalCompletedOrders: number;
  disputeRatePercent: number;
  accountAgeDays: number;
}

// The performance thresholds the controller owns are passed in so the numbers
// never diverge between the gating logic and what we show the merchant.
export interface CatalogThresholds {
  l2MinCompletedOrders: number;
  l2MaxDisputeRate: number; // percent
  l2MinAccountAgeDays: number;
  l3MinCompletedOrders: number;
  l3MaxDisputeRate: number; // percent
  verificationFee: number; // Naira
}

// Per-merchant facts that turn an abstract requirement into a met/unmet row.
export interface CatalogContext extends CatalogStats {
  currentLevel: number;
  hasCacDocument: boolean;
  verificationFeePaid: boolean;
}

export interface CatalogRequirement {
  key: string;
  label: string;
  met: boolean;
  current?: number;
  target?: number;
}

export interface CatalogLevel {
  level: number;
  label: string;
  tagline: string;
  settlementLabel: string;
  dailyLimitLabel: string;
  canSell: boolean;
  requirements: CatalogRequirement[];
  benefits: string[];
}

// A partial, admin-editable override for a single level. All fields optional.
export interface CatalogLevelOverride {
  label?: string;
  tagline?: string;
  benefits?: string[];
  // Map of requirement key -> replacement label (keeps met/current/target logic).
  requirementLabels?: Record<string, string>;
}

export type CatalogOverrides = Record<number, CatalogLevelOverride>;

// ── Human-readable formatters (mirror the Flutter model's getters) ────────────

function settlementLabelForLevel(level: number): string {
  const hours = settlementDelayHoursForDb(level);
  const rule = rulesForLevel(level);
  if (!rule.canSell) return "—"; // level 0 never settles (can't sell)
  return hours <= 0 ? "Instant" : `${hours}h`;
}

function dailyLimitLabelForLevel(level: number): string {
  const limit = dailyWithdrawalLimitForDb(level);
  if (limit >= UNLIMITED_DAILY_LIMIT) return "Unlimited";
  if (limit <= 0) return "—";
  return `₦${limit.toLocaleString()}`;
}

// ── Default descriptions (the editable copy) ──────────────────────────────────
// Keep these declarative; admin overrides merge on top.

const DEFAULT_LABELS: Record<number, string> = {
  0: "Unverified",
  1: "Identity Verified",
  2: "Trusted Merchant",
  3: "Business Verified",
};

const DEFAULT_TAGLINES: Record<number, string> = {
  0: "New account — verify to start selling.",
  1: "Identity confirmed — you can sell and appear in search.",
  2: "Proven track record — faster payouts and better visibility.",
  3: "Fully verified business — the blue badge, instant payouts and priority support.",
};

const DEFAULT_BENEFITS: Record<number, string[]> = {
  0: ["Browse and set up your store", "Verify your identity to unlock selling"],
  1: [
    "Sell and appear in search",
    "Accept orders with escrow protection",
    "Withdraw earnings to your bank",
  ],
  2: [
    "Faster settlements on completed orders",
    "Higher daily withdrawal limit",
    "Improved ranking in search and listings",
  ],
  3: [
    "Blue verified badge on your store",
    "Instant settlements after delivery",
    "Unlimited daily withdrawals",
    "Priority dispute handling and support",
    "Eligible to be featured",
  ],
};

// ── Requirement builders (met/unmet relative to the merchant) ─────────────────

function requirementsForLevel(
  level: number,
  ctx: CatalogContext,
  t: CatalogThresholds,
): CatalogRequirement[] {
  // A level is "already attained" if the merchant is at or above it; in that
  // case its entry requirements are all considered met.
  const attained = ctx.currentLevel >= level;

  switch (level) {
    case 0:
      return [{ key: "account", label: "Create a merchant account", met: true }];

    case 1:
      return [
        {
          key: "identity",
          label: "Submit a valid government ID",
          met: attained,
        },
      ];

    case 2:
      return [
        {
          key: "orders",
          label: `Complete ${t.l2MinCompletedOrders} orders`,
          met: attained || ctx.totalCompletedOrders >= t.l2MinCompletedOrders,
          current: ctx.totalCompletedOrders,
          target: t.l2MinCompletedOrders,
        },
        {
          key: "disputes",
          label: `Keep disputes under ${t.l2MaxDisputeRate}%`,
          met: attained || ctx.disputeRatePercent < t.l2MaxDisputeRate,
          current: Math.round(ctx.disputeRatePercent * 10) / 10,
          target: t.l2MaxDisputeRate,
        },
        {
          key: "age",
          label: `${t.l2MinAccountAgeDays} days on the platform`,
          met: attained || ctx.accountAgeDays >= t.l2MinAccountAgeDays,
          current: ctx.accountAgeDays,
          target: t.l2MinAccountAgeDays,
        },
      ];

    case 3:
      return [
        {
          key: "orders",
          label: `Complete ${t.l3MinCompletedOrders} orders`,
          met: attained || ctx.totalCompletedOrders >= t.l3MinCompletedOrders,
          current: ctx.totalCompletedOrders,
          target: t.l3MinCompletedOrders,
        },
        {
          key: "disputes",
          label: `Keep disputes under ${t.l3MaxDisputeRate}%`,
          met: attained || ctx.disputeRatePercent < t.l3MaxDisputeRate,
          current: Math.round(ctx.disputeRatePercent * 10) / 10,
          target: t.l3MaxDisputeRate,
        },
        {
          key: "cac",
          label: "Upload CAC certificate",
          met: attained || ctx.hasCacDocument,
        },
        {
          key: "fee",
          label: `Pay ₦${t.verificationFee.toLocaleString()} verification fee`,
          met: attained || ctx.verificationFeePaid,
        },
        { key: "admin", label: "Admin review & approval", met: attained },
      ];

    default:
      return [];
  }
}

// ── The builder ───────────────────────────────────────────────────────────────

/**
 * Build the full 0→3 level catalog for a given merchant. Pure & synchronous so
 * it can be embedded in serializeProfile. Pass `overrides` (e.g. admin-edited
 * JSON) to replace taglines / benefits / requirement labels per level.
 */
export function buildTrustLevelCatalog(
  ctx: CatalogContext,
  t: CatalogThresholds,
  overrides: CatalogOverrides | null = null,
): CatalogLevel[] {
  return [0, 1, 2, 3].map((level) => {
    const o = overrides?.[level] ?? {};
    const rule = rulesForLevel(level);

    let requirements = requirementsForLevel(level, ctx, t);
    // Apply admin label overrides while preserving met/current/target.
    if (o.requirementLabels) {
      requirements = requirements.map((r) =>
        o.requirementLabels && o.requirementLabels[r.key]
          ? { ...r, label: o.requirementLabels[r.key] }
          : r,
      );
    }

    return {
      level,
      label: o.label ?? DEFAULT_LABELS[level] ?? `Level ${level}`,
      tagline: o.tagline ?? DEFAULT_TAGLINES[level] ?? "",
      settlementLabel: settlementLabelForLevel(level),
      dailyLimitLabel: dailyLimitLabelForLevel(level),
      canSell: rule.canSell,
      requirements,
      benefits: o.benefits ?? DEFAULT_BENEFITS[level] ?? [],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONAL — make the catalog admin-editable at runtime (no app release):
//
// 1) Add an optional JSON column to AppConfig (additive migration):
//      // prisma/schema.prisma — model AppConfig
//      trustCatalog Json?   // { "3": { "benefits": ["...","..."], "tagline": "..." } }
//
// 2) In getTrustStatus, read it and pass it through:
//      const cfg = await prisma.appConfig.findFirst();
//      const overrides = (cfg?.trustCatalog as CatalogOverrides) ?? null;
//      ... serializeProfile(profile, stats, hasCacDoc, pendingRequest, overrides)
//
// 3) Expose an admin endpoint to PATCH AppConfig.trustCatalog.
//
// Until that column exists, buildTrustLevelCatalog uses the defaults above, and
// editing the defaults + redeploying is the way to change copy. The override
// path is wired and ready (serializeProfile already forwards an overrides arg),
// so flipping to fully DB-driven later is a two-line change.
// ─────────────────────────────────────────────────────────────────────────────