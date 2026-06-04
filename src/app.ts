import express from "express";
import routes from "./routes";
import cors from "cors"
import { serveAasa, serveAssetLinks } from "./wellKnown";

const app = express();


// CORS configuration: allow only the official frontend origins and localhost for dev. This is important for security, especially since the API uses cookie-based auth.
// The Flutter app's http client doesn't send an Origin header, so we allow that
// by default. The Cloudflare worker's fetch also sends no Origin, so it can
// access the API without CORS issues.

const allowedOrigins = ["https://amril.app", "https://www.amril.app"];
app.use(cors({
  origin(origin, callback) {
    // No Origin header = same-origin, server-to-server (the Cloudflare worker's
    // /web/* fetch), the Flutter app (http/dio send no Origin), curl. Allow.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Local dev: any localhost / 127.0.0.1 port.
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());

// ── Well-known association files (Android App Links / iOS Universal Links) ──
// Mounted BEFORE the module router so nothing else can shadow them. Served
// inline (see wellKnown.ts) with application/json and no redirect.
app.get("/.well-known/assetlinks.json", serveAssetLinks);
app.get("/.well-known/apple-app-site-association", serveAasa);

app.use(routes)

export default app;