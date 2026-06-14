// REPO PATH: src/shared/services/reconciliation.service.ts   (NEW FILE)
//
// The whole reconciliation computation, read-only. Callers (admin endpoint /
// nightly cron) decide whether to persist a snapshot.
//
// Golden invariants (BUILD_STATE):
//   Track A  Σ(user available+locked) + Σ(merchant pending)  ≤  Paystack + OPay
//   Track B  Σ(NG earned coins × conversionRate)             ≤  NG coin proceeds
//                                                                + Apple + Google
//                                                                − conversions paid
// Never spend the float; the cushion is unswept revenue.

import axios from "axios";
import { ReconStatus } from "@prisma/client";
import { prisma } from "../../prisma";
import { sumRevenue } from "./revenue.service";
// Reuse the CANONICAL coin rules so reconciliation never diverges from runtime.
import { getCoinRates, isNgTied } from "../helpers/coin.helpers";

const round2 = (n: number) => Math.round(n * 100) / 100;

// Live path uses PAYSTACK_SECRET (transfers/webhook); fall back to the DVA name.
const PAYSTACK_SECRET =
  process.env.PAYSTACK_SECRET ?? process.env.PAYSTACK_SECRET_KEY ?? "";

/**
 * Live Paystack NGN balance (kobo → naira). Degrades gracefully: any failure
 * (no secret, network, unexpected shape) returns ok:false + a reason so the
 * snapshot falls back to a manual figure rather than throwing.
 */
export async function fetchPaystackBalanceNgn(): Promise<{
  ok: boolean;
  balance: number;
  reason?: string;
}> {
  if (!PAYSTACK_SECRET) return { ok: false, balance: 0, reason: "PAYSTACK_SECRET not set" };
  try {
    const r = await axios.get("https://api.paystack.co/balance", {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
      timeout: 12000,
    });
    const list = r.data?.data ?? [];
    const ngn = Array.isArray(list)
      ? list.find((b: any) => String(b.currency).toUpperCase() === "NGN")
      : null;
    return { ok: true, balance: round2((ngn?.balance ?? 0) / 100) };
  } catch (e: any) {
    return { ok: false, balance: 0, reason: e?.response?.data?.message ?? e?.message ?? "fetch failed" };
  }
}

export interface ReconInputs {
  opayBalance?: number;   // admin-entered (OPay merchant balance)
  appleBalance?: number;  // admin-entered (App Store Connect pending payout, ₦)
  googleBalance?: number; // admin-entered (Play Console pending payout, ₦)
  paystackOverride?: number; // skip the live fetch and use this instead
}

function statusFor(surplus: number, liability: number): ReconStatus {
  if (surplus < 0) return ReconStatus.breach;             // underwater
  if (liability > 0 && surplus < liability * 0.05) return ReconStatus.warn; // <5% cushion
  return ReconStatus.ok;
}

export async function computeReconciliation(inputs: ReconInputs = {}) {
  // ── Track A: NGN wallet float ───────────────────────────────────────────
  const fiatAgg = await prisma.fiat.aggregate({
    _sum: { availableBalance: true, lockedBalance: true, rewardBalance: true },
  });
  const userAvailable = round2(fiatAgg._sum.availableBalance ?? 0);
  const userLocked = round2(fiatAgg._sum.lockedBalance ?? 0);
  const userRewards = round2(fiatAgg._sum.rewardBalance ?? 0); // info: promo, not hard cash

  let merchantPending = 0;
  try {
    const mb = await prisma.merchantBalance.aggregate({ _sum: { pending: true } });
    merchantPending = round2(mb._sum.pending ?? 0);
  } catch {
    /* settlement tables may pre-date migration */
  }

  const ngnLiabilities = round2(userAvailable + userLocked + merchantPending);

  // Observed float
  let paystackBalance = 0,
    paystackFetchOk = false,
    paystackReason: string | undefined;
  if (typeof inputs.paystackOverride === "number") {
    paystackBalance = round2(inputs.paystackOverride);
    paystackReason = "manual override";
  } else {
    const pf = await fetchPaystackBalanceNgn();
    paystackBalance = pf.balance;
    paystackFetchOk = pf.ok;
    paystackReason = pf.reason;
  }
  const opayBalance = round2(inputs.opayBalance ?? 0);
  const ngnFloat = round2(paystackBalance + opayBalance);
  const ngnSurplus = round2(ngnFloat - ngnLiabilities);
  const ngnRevenueTotal = round2(await sumRevenue({ track: "ngn_float" }));
  const ngnStatus = statusFor(ngnSurplus, ngnLiabilities);
  const unexplainedGap = round2(ngnSurplus - ngnRevenueTotal); // ≈ sweeps; large = leak

  // ── Track B: coin treasury ──────────────────────────────────────────────
  const { purchaseRateNgn, conversionRate } = await getCoinRates();

  // Split earned coins NG vs non-NG (only NG-tied convert to cash).
  let ngEarnedCoins = 0,
    nonNgEarnedCoins = 0,
    purchasedOutstanding = 0;
  try {
    const ledgers = await prisma.userCoins.findMany({
      select: {
        earnedCoins: true,
        purchasedCoins: true,
        user: { select: { phone: true, country: true } },
      },
    });
    for (const l of ledgers) {
      purchasedOutstanding += l.purchasedCoins ?? 0;
      const ngTied = isNgTied({ phone: l.user?.phone ?? null, country: l.user?.country ?? null });
      if (ngTied) ngEarnedCoins += l.earnedCoins ?? 0;
      else nonNgEarnedCoins += l.earnedCoins ?? 0;
    }
  } catch {
    /* coin tables absent */
  }
  const coinLiability = round2(ngEarnedCoins * conversionRate);

  // Coin funding pool
  let coinPurchaseProceedsNg = 0,
    conversionsPaid = 0;
  try {
    // NG coin proceeds only. Verified NG buys (opay_ngn / wallet_ngn) carry a ₦
    // amount; verified IAP rows are amount 0 in USD — the `currency: "NGN"` filter
    // makes the "NG ₦ proceeds" intent explicit and future-proof.
    const cp = await prisma.coinPurchase.aggregate({
      _sum: { amount: true },
      where: { verified: true, currency: "NGN" },
    });
    coinPurchaseProceedsNg = round2(cp._sum.amount ?? 0);
  } catch {}
  try {
    const cc = await prisma.coinConversion.aggregate({ _sum: { nairaAmount: true } });
    conversionsPaid = round2(cc._sum.nairaAmount ?? 0);
  } catch {}

  const appleBalance = round2(inputs.appleBalance ?? 0);
  const googleBalance = round2(inputs.googleBalance ?? 0);
  const coinFunding = round2(
    coinPurchaseProceedsNg + appleBalance + googleBalance - conversionsPaid,
  );
  const coinSurplus = round2(coinFunding - coinLiability);
  const coinRevenueTotal = round2(await sumRevenue({ track: "coin" }));
  const coinStatus = statusFor(coinSurplus, coinLiability);

  return {
    takenAt: new Date().toISOString(),
    ngn: {
      userAvailable,
      userLocked,
      userRewards,
      merchantPending,
      liabilities: ngnLiabilities,
      paystackBalance,
      paystackFetchOk,
      paystackReason,
      opayBalance,
      float: ngnFloat,
      surplus: ngnSurplus,
      revenueTotal: ngnRevenueTotal,
      unexplainedGap,
      status: ngnStatus,
    },
    coin: {
      conversionRate,
      purchaseRate: purchaseRateNgn,
      ngEarnedCoins,
      coinLiability,
      nonNgEarnedCoins, // info — never converts
      purchasedOutstanding, // info — spend-only, deferred revenue
      coinPurchaseProceedsNg, // NOTE: physically sits in the PSP float, earmarked here
      appleBalance,
      googleBalance,
      conversionsPaid,
      funding: coinFunding,
      surplus: coinSurplus,
      revenueTotal: coinRevenueTotal,
      status: coinStatus,
    },
  };
}