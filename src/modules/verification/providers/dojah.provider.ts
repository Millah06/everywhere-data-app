// src/modules/verification/providers/dojah.provider.ts
//
// PHASE 13 — Dojah implementation of IdentityProvider.
// ─────────────────────────────────────────────────────────────────────────────
// Synchronous BVN/NIN lookups (no webhook needed). Same axios + process.env
// pattern as the Paystack calls in externalWithdrawal.controller.
//
// ════════════════════════ SETUP (do this once) ══════════════════════════════
// 1. Create an account at https://dojah.io and create an App in the dashboard.
// 2. Copy two values from the app's "API Keys" / "Keys" section:
//       • App ID         → DOJAH_APP_ID
//       • Secret/Prod Key → DOJAH_API_KEY     (use the SANDBOX key while testing)
// 3. Add to your Render environment (Dashboard → Environment), NOT in code:
//       DOJAH_APP_ID   = xxxxxxxxxxxxxxxxxxxxxxxx
//       DOJAH_API_KEY  = prod_or_test_xxxxxxxxxxxx
//       DOJAH_BASE_URL = https://sandbox.dojah.io      ← while testing
//                        https://api.dojah.io          ← switch to this for live
// 4. Sandbox gives you test BVN/NIN values in the Dojah docs to verify the flow.
//
// ⚠️ CONFIRM AT INTEGRATION: Dojah occasionally tweaks endpoint paths and the
// exact JSON field names. The paths + `entity` parsing below match Dojah's
// documented v1 KYC API at time of writing — run ONE sandbox call and adjust the
// two ENDPOINT constants / field reads if their response differs. Everything
// else (the seam, the gates, the badge) is provider-agnostic and won't change.
// ─────────────────────────────────────────────────────────────────────────────

import axios from "axios";
import type {
  IdentityProvider,
  IdentityResult,
} from "./identity.provider";

const BASE_URL = process.env.DOJAH_BASE_URL || "https://sandbox.dojah.io";

// Documented Dojah KYC lookup paths (confirm in sandbox — see header note).
const NIN_ENDPOINT = "/api/v1/kyc/nin"; // ?nin=
const BVN_ENDPOINT = "/api/v1/kyc/bvn/full"; // ?bvn=

function headers() {
  const appId = process.env.DOJAH_APP_ID;
  const apiKey = process.env.DOJAH_API_KEY;
  if (!appId || !apiKey) {
    // Fail loud in logs but let the caller turn it into a clean 503 — never
    // silently "pass" a verification because the keys are missing.
    throw new Error("DOJAH_NOT_CONFIGURED");
  }
  return {
    // Dojah uses the secret key directly in Authorization (no "Bearer ").
    Authorization: apiKey,
    AppId: appId,
    "Content-Type": "application/json",
  };
}

// Dojah wraps the resolved person in `entity`. Field names vary slightly between
// the NIN and BVN products, so we read defensively.
function parseEntity(
  data: any,
  method: "bvn" | "nin",
): IdentityResult {
  const entity = data?.entity ?? data?.data?.entity ?? null;
  if (!entity) {
    return { ok: false, method, error: "No identity record found." };
  }
  return {
    ok: true,
    method,
    providerRef:
      data?.reference_id ||
      data?.entity?.reference_id ||
      entity?.id ||
      undefined,
    firstName: entity.first_name ?? entity.firstName,
    lastName: entity.last_name ?? entity.lastName,
    middleName: entity.middle_name ?? entity.middleName,
    // NIN → phone_number; BVN → phone_number1 (with fallbacks).
    phone:
      entity.phone_number ??
      entity.phone_number1 ??
      entity.phoneNumber ??
      undefined,
    dob: entity.date_of_birth ?? entity.dob ?? undefined,
  };
}

async function lookup(
  path: string,
  query: Record<string, string>,
  method: "bvn" | "nin",
): Promise<IdentityResult> {
  try {
    const res = await axios.get(`${BASE_URL}${path}`, {
      headers: headers(),
      params: query,
      validateStatus: () => true, // we inspect the body ourselves
      timeout: 20000,
    });

    if (res.status === 200 && (res.data?.entity || res.data?.data?.entity)) {
      return parseEntity(res.data, method);
    }

    // Dojah returns 4xx with an `error` message for bad/blocked numbers.
    const msg =
      res.data?.error ||
      res.data?.message ||
      "Verification failed. Check the number and try again.";
    return { ok: false, method, error: String(msg) };
  } catch (e: any) {
    if (e?.message === "DOJAH_NOT_CONFIGURED") throw e;
    return {
      ok: false,
      method,
      error: e?.response?.data?.error || "Identity service unavailable.",
    };
  }
}

export const DojahProvider: IdentityProvider = {
  verifyNin: (nin: string) => lookup(NIN_ENDPOINT, { nin }, "nin"),
  verifyBvn: (bvn: string) => lookup(BVN_ENDPOINT, { bvn }, "bvn"),
};

// Single export the controller imports — swap this line to change providers.
export const identityProvider: IdentityProvider = DojahProvider;