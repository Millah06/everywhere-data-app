import express from "express";
import routes from "./routes";
import cors from "cors"
import { serveAasa, serveAssetLinks } from "./wellKnown";

const app = express();


app.use(cors({origin: true}));
app.use(express.json());

// ── Well-known association files (Android App Links / iOS Universal Links) ──
// Mounted BEFORE the module router so nothing else can shadow them. Served
// inline (see wellKnown.ts) with application/json and no redirect.
app.get("/.well-known/assetlinks.json", serveAssetLinks);
app.get("/.well-known/apple-app-site-association", serveAasa);

app.use(routes)

export default app;