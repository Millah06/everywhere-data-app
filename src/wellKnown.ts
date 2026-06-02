// src/wellKnown.ts
//
// PHASE 1 — FOUNDATION
//
// Serves the two association files that make universal/app links verify:
//   • /.well-known/assetlinks.json            (Android App Links)
//   • /.well-known/apple-app-site-association  (iOS Universal Links)
//
// DEVIATION FROM SPEC (deliberate): the spec suggested `res.sendFile` from a
// `src/static/` folder. On Render the backend is built with `tsc` → `dist/`,
// and tsc does NOT copy non-`.ts` files, so `dist/static/...` would be missing
// at runtime → silent 404 → links never verify. Serving the payloads INLINE
// (below) is build-mode agnostic and cannot 404 from a missing copy step. The
// content, content-type, and "no redirect" guarantees are identical.
//
// NOTE ON HOSTS: the canonical App-Link host is `amril.app` (Cloudflare Pages),
// which serves its OWN copies via `_redirects` passthrough in Phase 3. This
// backend copy covers the API host and serves as a verifiable source of truth.
//
import { Request, Response } from "express";

// ── Android ───────────────────────────────────────────────────────────────
// The SHA-256 is the RELEASE signing certificate of the `com.amril.app` build.
// Obtain it with:   cd android && ./gradlew signingReport
// then paste the SHA-256 of the *release* variant in place of the placeholder.
// Multiple fingerprints (e.g. Play App Signing + upload key) can be listed.
const ASSETLINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.amril.app",
      sha256_cert_fingerprints: [
        "REPLACE_WITH_RELEASE_SHA256", // e.g. "AB:CD:12:...:EF"
      ],
    },
  },
];

// ── iOS ─────────────────────────────────────────────────────────────────────
// `TEAM_ID` is the Apple Developer Team ID (Apple Developer → Membership).
// Until the Apple account exists, leave the placeholder — iOS links simply
// won't verify; Android is unaffected. Paths mirror the GoRouter deep-link
// routes that should open the app rather than the browser.
const AASA = {
  applinks: {
    apps: [],
    details: [
      {
        appID: "REPLACE_WITH_APPLE_TEAM_ID.com.amril.app",
        paths: [
          "/store/*",
          "/product/*",
          "/order/*",
          "/join/*",
          "/store/*/table/*",
        ],
      },
    ],
  },
};

/** GET /.well-known/assetlinks.json */
export const serveAssetLinks = (_req: Request, res: Response) => {
  res.type("application/json").send(JSON.stringify(ASSETLINKS));
};

/**
 * GET /.well-known/apple-app-site-association
 * MUST be served as application/json and MUST NOT redirect — Apple's CDN
 * fetches this exact path with no following of redirects.
 */
export const serveAasa = (_req: Request, res: Response) => {
  res.type("application/json").send(JSON.stringify(AASA));
};