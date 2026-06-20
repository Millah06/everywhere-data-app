// src/modules/verification/providers/identity.provider.ts
//
// PHASE 13 — Identity verification seam.
// ─────────────────────────────────────────────────────────────────────────────
// The rest of the app talks to THIS interface, never to Dojah directly. That way
// the provider can be swapped (Dojah → QoreID/Smile ID) by writing one new file,
// with zero changes to the controller or the gates.
// ─────────────────────────────────────────────────────────────────────────────

export type IdentityMethod = "bvn" | "nin";

export interface IdentityResult {
  /** true only when the number resolved to a real, active identity record. */
  ok: boolean;
  method: IdentityMethod;
  /** Provider-side reference we persist instead of the raw number (NDPA). */
  providerRef?: string;
  // Resolved identity from the government record (used for the name-match gate).
  firstName?: string;
  lastName?: string;
  middleName?: string;
  /** Phone registered against the BVN/NIN — this is the "free" phone proof. */
  phone?: string;
  dob?: string;
  /** Human-readable failure reason when ok === false. */
  error?: string;
}

export interface IdentityProvider {
  verifyNin(nin: string): Promise<IdentityResult>;
  verifyBvn(bvn: string): Promise<IdentityResult>;
}