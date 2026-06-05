// src/modules/payment/providers/opay.service.ts
//
// OPay Express Checkout (International Cashier) provider.
//
// This mirrors the EXACT request shape already proven to work in
// `src/modules/wallet/controllers/opayPayment.ts` (cashier `create` with
// `Authorization: Bearer <PublicKey>` + `MerchantId` headers). We only add:
//   • env-driven credentials + sandbox/prod base URL (no hardcoded secrets),
//   • a `status` query that is the AUTHORITATIVE source of truth for a payment,
//   • HMAC-SHA512 signing for the status call,
//   • best-effort webhook signature verification.
//
// DESIGN RULE (spec §12, §13): the redirect/webhook are NEVER trusted on their
// own. Money decisions are made only after `queryStatus()` confirms the order
// with OPay. So even if OPay's webhook signature scheme differs from what we
// verify here, we cannot be tricked into crediting — we always re-query.

import axios from "axios";
import crypto from "crypto";
import { nanoid } from "nanoid";

// ─────────────────────────────────────────────────────────────────────────────
// Credentials & environment.
//
// Move the values currently hardcoded in opayPayment.ts into these env vars.
// See PHASE5_OPAY_SETUP.md for where to find each one in the OPay dashboard.
// ─────────────────────────────────────────────────────────────────────────────
const OPAY_ENV = (process.env.OPAY_ENV || "sandbox").toLowerCase(); // "sandbox" | "production"
const OPAY_PUBLIC_KEY = process.env.OPAY_PUBLIC_KEY || "OPAYPUB17795318006960.42281797604856775";
const OPAY_SECRET_KEY = process.env.OPAY_SECRET_KEY || "REPLACE_WITH_OPAY_PRIVATE_KEY"; // HMAC key — the OPAYPRV... key
const OPAY_MERCHANT_ID = process.env.OPAY_MERCHANT_ID || "256626052384533";
const OPAY_DISPLAY_NAME = process.env.OPAY_DISPLAY_NAME || "Amrili Digital Services Limited";

// The verified-working host is testapi/liveapi.opaycheckout.com (see the
// existing controller). The spec also lists sandboxapi/api.opaycheckout.com;
// both are overridable via OPAY_BASE_URL if your account differs.
const OPAY_BASE_URL =
  process.env.OPAY_BASE_URL ||
  (OPAY_ENV === "production"
    ? "https://liveapi.opaycheckout.com"
    : "https://testapi.opaycheckout.com");

// OPay's International Cashier amounts are in the currency's MINOR unit (kobo).
// ₦2,500 => 250000. If your account is configured for major units, set
// OPAY_AMOUNT_MINOR_UNIT=false. VERIFY THIS IN SANDBOX before going live — a
// wrong setting is a 100x error. (PHASE5_OPAY_SETUP.md → "Verify amount units".)
const AMOUNT_IN_MINOR_UNIT =
  (process.env.OPAY_AMOUNT_MINOR_UNIT || "true").toLowerCase() !== "false";

const CASHIER_CREATE = "/api/v1/international/cashier/create";
const CASHIER_STATUS = "/api/v1/international/cashier/status";

function toProviderAmount(naira: number): number {
  return AMOUNT_IN_MINOR_UNIT ? Math.round(naira * 100) : Math.round(naira);
}
export function fromProviderAmount(providerAmount: number): number {
  return AMOUNT_IN_MINOR_UNIT ? providerAmount / 100 : providerAmount;
}

// HMAC-SHA512 over the canonical JSON body, hex-encoded. OPay's status/refund
// calls expect `Authorization: Bearer <thisSignature>` (the private key is the
// HMAC key, never sent on the wire).
function sign(payload: unknown): string {
  return crypto
    .createHmac("sha512", OPAY_SECRET_KEY)
    .update(JSON.stringify(payload))
    .digest("hex");
}

export interface OpayCreateInput {
  /** Our Payment.id — used as OPay `reference` so webhook/query can find us. */
  reference: string;
  /** Amount in NAIRA (major unit). Converted to OPay's unit internally. */
  amountNaira: number;
  /** Where OPay sends the browser after pay. Cosmetic only — never trusted. */
  returnUrl: string;
  /** Shown on the cashier page. */
  productName: string;
  productDescription?: string;
  /** "ANDROID" | "IOS" | "WEB" — OPay analytics field. */
  customerVisitSource?: string;
}

export interface OpayCreateResult {
  /** URL to open in the WebView. */
  cashierUrl: string;
  /** OPay's own order number, if returned — stored as providerRef alongside ours. */
  orderNo?: string;
  raw: unknown;
}

/**
 * Create an OPay cashier session. Returns the URL the client opens in a WebView.
 * Mirrors the proven header/payload shape from opayPayment.ts.
 */
export async function createCashier(input: OpayCreateInput): Promise<OpayCreateResult> {
  const url = `${OPAY_BASE_URL}${CASHIER_CREATE}`;

  const payload = {
    reference: input.reference,
    amount: {
      total: toProviderAmount(input.amountNaira),
      currency: "NGN",
    },
    returnUrl: input.returnUrl,
    displayName: OPAY_DISPLAY_NAME,
    customerVisitSource: input.customerVisitSource || "ANDROID",
    evokeOpay: true,
    expireAt: Number(process.env.OPAY_EXPIRE_SECONDS || 1800), // 30 min default
    // `sn` is the OPay POS/serial identifier from the existing controller.
    sn: process.env.OPAY_SN || "",
    product: {
      name: input.productName,
      description: input.productDescription || input.productName,
    },
    payMethod: process.env.OPAY_PAY_METHOD || "OpayWalletNg", // BankCard | OpayWalletNg | BankTransfer ...
    country: "NG",
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Create uses the PUBLIC key as Bearer (verified working in opayPayment.ts).
    // Some merchant configs require the HMAC signature instead — set
    // OPAY_SIGN_CREATE=true to switch.
    Authorization:
      (process.env.OPAY_SIGN_CREATE || "false").toLowerCase() === "true"
        ? `Bearer ${sign(payload)}`
        : `Bearer ${OPAY_PUBLIC_KEY}`,
    MerchantId: OPAY_MERCHANT_ID,
  };

  const { data } = await axios.post(url, payload, { headers, timeout: 20000 });

  // OPay envelope: { code, message, data: { reference, orderNo, cashierUrl, status } }
  const d = data?.data ?? {};
  const cashierUrl: string | undefined = d.cashierUrl || d.cashierURL || d.url;
  if (!cashierUrl) {
    throw new Error(
      `OPay create returned no cashierUrl (code=${data?.code} message=${data?.message})`,
    );
  }
  return { cashierUrl, orderNo: d.orderNo, raw: data };
}

export type OpayQueryStatus = "SUCCESS" | "FAILED" | "PENDING";

export interface OpayQueryResult {
  status: OpayQueryStatus;
  /** Amount OPay reports, in NAIRA (already converted from minor unit). */
  amountNaira?: number;
  orderNo?: string;
  raw: unknown;
}

/**
 * AUTHORITATIVE status check. Call this before moving any money. Maps OPay's
 * granular statuses onto our three buckets.
 *
 * OPay status values seen in the wild: INITIAL / PENDING → PENDING;
 * SUCCESS → SUCCESS; FAIL / FAILED / CLOSE / EXPIRED → FAILED.
 */
export async function queryStatus(reference: string): Promise<OpayQueryResult> {
  const url = `${OPAY_BASE_URL}${CASHIER_STATUS}`;
  const payload = { reference, country: "NG" };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${sign(payload)}`, // status REQUIRES the HMAC signature
    MerchantId: OPAY_MERCHANT_ID,
  };

  const { data } = await axios.post(url, payload, { headers, timeout: 20000 });
  const d = data?.data ?? {};
  const raw = String(d.status || "").toUpperCase();

  let status: OpayQueryStatus = "PENDING";
  if (raw === "SUCCESS") status = "SUCCESS";
  else if (["FAIL", "FAILED", "CLOSE", "CLOSED", "EXPIRED"].includes(raw)) {
    status = "FAILED";
  }

  const amountTotal =
    typeof d.amount?.total === "number" ? d.amount.total : undefined;

  return {
    status,
    amountNaira: amountTotal != null ? fromProviderAmount(amountTotal) : undefined,
    orderNo: d.orderNo,
    raw: data,
  };
}

/**
 * Best-effort webhook signature verification. OPay signs the callback; the
 * exact field set can vary by account, so this is intentionally lenient and is
 * NOT the security boundary — `queryStatus()` is. Returns true if the signature
 * matches OR if no signing secret/header is configured (so we still proceed to
 * the authoritative re-query rather than silently dropping callbacks).
 */
export function verifyWebhookSignature(
  body: any,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return true; // no header → rely on queryStatus
  try {
    // OPay typically signs the `payload` object (or the whole body) with SHA512.
    const target = body?.payload ?? body;
    const expected = crypto
      .createHmac("sha512", OPAY_SECRET_KEY)
      .update(JSON.stringify(target))
      .digest("hex");
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(String(signatureHeader)),
    );
  } catch {
    return false;
  }
}

/** Extract our Payment reference from an OPay webhook body (tolerant of shapes). */
export function extractWebhookReference(body: any): string | undefined {
  return (
    body?.payload?.reference ||
    body?.reference ||
    body?.data?.reference ||
    undefined
  );
}

export function newOpayReference(): string {
  // Kept compatible with the existing controller's style (uppercase, short).
  return nanoid().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

export const OPAY_CONFIG_SUMMARY = {
  env: OPAY_ENV,
  baseUrl: OPAY_BASE_URL,
  merchantIdSet: OPAY_MERCHANT_ID !== "256626052384533",
  publicKeySet: OPAY_PUBLIC_KEY !== "OPAYPUB17795318006960.42281797604856775",
  secretKeySet: OPAY_SECRET_KEY !== "REPLACE_WITH_OPAY_PRIVATE_KEY",
  amountInMinorUnit: AMOUNT_IN_MINOR_UNIT,
};