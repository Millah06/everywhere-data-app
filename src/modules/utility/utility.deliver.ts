// src/modules/utility/utility.deliver.ts
//
// Single VTPass delivery function used by the payment engine's `utility`
// handler. The engine has already taken the money (wallet debit or OPay verify)
// by the time this runs — this ONLY fulfils the service with VTPass and reports
// the delivery outcome. Refunds on failure are handled by the handler.
//
// Payload/auth differences are real and verified against the existing
// per-service controllers:
//   • airtime           → api-key/secret-key, { request_id, serviceID, amount, phone }
//   • data              → api-key/secret-key, { request_id, serviceID, billersCode:phone, variation_code, phone }
//   • smile             → api-key/secret-key, { request_id, serviceID, billersCode:accountID, variation_code, phone }
//   • electricity       → api-key/secret-key, { request_id, serviceID, billersCode:meter, amount, phone, variation_code:meterType }
//   • exams (jamb/waec) → api-key/secret-key, reuses the electricity-style call (billersCode, variation_code, quantity)
//   • cable (DStv/…)    → BASIC auth (VTPASS_USERNAME:PASSWORD), { request_id, serviceID, billersCode:smartcard, variation_code, phone, subscription_type }

import axios from "axios";

const VT_PAY = "https://vtpass.com/api/pay";

export type UtilityService =
  | "airtime"
  | "data"
  | "smile"
  | "electricity"
  | "cable"
  | "jamb"
  | "waec"
  | "waec-registration";

export interface UtilityRequest {
  service: UtilityService;
  /** VTPass serviceID, e.g. "mtn", "ikeja-electric", "dstv", "jamb". */
  serviceID: string;
  phone: string;
  /** Variable-price services (airtime, electricity, exams). */
  amount?: number;
  /** Data plan / cable bouquet / meter type / exam variation. */
  variationCode?: string;
  /** Meter number / smartcard / Smile accountID / exam profile code. */
  billersCode?: string;
  /** Cable only. */
  subscriptionType?: string;
  /** Exams (waec/jamb) — number of pins. */
  quantity?: number;
  /** For receipts. */
  productName?: string;
}

export type DeliveryStatus = "delivered" | "pending" | "failed";

export interface DeliveryResult {
  status: DeliveryStatus;
  token?: string | null;
  /** WAEC multi-pin etc. */
  tokens?: unknown;
  productName?: string;
  vendorResponse: unknown;
}

// VTPass status string → our three buckets. Mirrors the existing controllers'
// classification (delivered = success; initiated/pending = pending; else fail).
function classify(raw: string | undefined): DeliveryStatus {
  const s = (raw || "").toLowerCase();
  if (s === "delivered") return "delivered";
  if (s === "pending" || s === "initiated" || s === "processing") return "pending";
  return "failed";
}

function apiKeyHeaders() {
  return {
    "api-key": process.env.VTPASS_API_KEY,
    "secret-key": process.env.VTPASS_SECRET_KEY,
  };
}

function basicAuthHeaders() {
  const auth = Buffer.from(
    `${process.env.VTPASS_USERNAME}:${process.env.VTPASS_PASSWORD}`,
  ).toString("base64");
  return { Authorization: `Basic ${auth}` };
}

// Build the exact VTPass body + headers for each service.
function buildRequest(r: UtilityRequest, requestId: string): {
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
} {
  switch (r.service) {
    case "airtime":
      return {
        body: { request_id: requestId, serviceID: r.serviceID, amount: r.amount, phone: r.phone },
        headers: apiKeyHeaders(),
      };
    case "data":
      return {
        body: {
          request_id: requestId,
          serviceID: r.serviceID,
          billersCode: r.phone,
          variation_code: r.variationCode,
          phone: r.phone,
        },
        headers: apiKeyHeaders(),
      };
    case "smile":
      return {
        body: {
          request_id: requestId,
          serviceID: r.serviceID,
          billersCode: r.billersCode,
          variation_code: r.variationCode,
          phone: r.phone,
        },
        headers: apiKeyHeaders(),
      };
    case "electricity":
      return {
        body: {
          request_id: requestId,
          serviceID: r.serviceID,
          billersCode: r.billersCode,
          amount: r.amount,
          phone: r.phone,
          variation_code: r.variationCode, // meterType
        },
        headers: apiKeyHeaders(),
      };
    case "jamb":
    case "waec":
    case "waec-registration":
      // Exams reuse the same VTPass /pay shape the existing electricity
      // controller used for these serviceIDs (billersCode = profile code,
      // variation_code = exam variation, quantity for waec pins).
      return {
        body: {
          request_id: requestId,
          serviceID: r.serviceID,
          billersCode: r.billersCode,
          amount: r.amount,
          phone: r.phone,
          variation_code: r.variationCode,
          ...(r.quantity ? { quantity: r.quantity } : {}),
        },
        headers: apiKeyHeaders(),
      };
    case "cable":
      return {
        body: {
          request_id: requestId,
          serviceID: r.serviceID,
          billersCode: r.billersCode, // smartcard
          variation_code: r.variationCode,
          phone: r.phone,
          subscription_type: r.subscriptionType || "change",
        },
        headers: basicAuthHeaders(), // cable uses BASIC auth, not api-key
      };
  }
}

// Pull whatever "token"/"pin" a service returns, for the receipt.
function extractToken(service: UtilityService, data: any): { token?: string | null; tokens?: unknown } {
  try {
    switch (service) {
      case "electricity":
        return { token: data?.Token ?? data?.token ?? null };
      case "jamb":
        return { token: data?.purchased_code?.split(" : ")?.[1] ?? data?.purchased_code ?? null };
      case "waec":
      case "waec-registration":
        if (Array.isArray(data?.cards)) return { tokens: data.cards };
        if (Array.isArray(data?.tokens)) return { tokens: data.tokens };
        return { token: data?.purchased_code ?? null };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

/**
 * Fulfil a utility request with VTPass. `requestId` MUST be stable + unique per
 * payment (we pass the Payment.id) so VTPass's async webhook can map back.
 */
export async function deliverUtility(
  r: UtilityRequest,
  requestId: string,
): Promise<DeliveryResult> {
  const { body, headers } = buildRequest(r, requestId);

  let vendorResponse: any;
  try {
    const resp = await axios.post(VT_PAY, body, { headers, timeout: 20000 });
    vendorResponse = resp.data;
  } catch (err: any) {
    return { status: "failed", vendorResponse: { error: err?.message }, productName: r.productName };
  }

  if (vendorResponse?.error) {
    return { status: "failed", vendorResponse, productName: r.productName };
  }

  const rawStatus = vendorResponse?.content?.transactions?.status;
  const status = classify(rawStatus);
  const tok = status === "delivered" ? extractToken(r.service, vendorResponse) : {};
  const productName =
    vendorResponse?.content?.transactions?.product_name || r.productName;

  return { status, vendorResponse, productName, ...tok };
}