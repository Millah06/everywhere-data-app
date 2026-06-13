// src/modules/social/controllers/coinController.ts
//
// PHASE 10 — Coin purchase (non-NG, store IAP) + boost.
//
// Two funding rails, chosen by region:
//   • NG-tied users buy coins through the EXISTING payment engine (Wallet/OPay)
//     via entityType "coin_purchase" — see coin.payment.handler.ts. They never
//     touch this file's IAP path. Price is in naira, from AppConfig.
//   • Non-NG users buy through Apple IAP / Google Play Billing. The store owns
//     the localized price; the client sends the receipt to /coins/purchase/iap
//     and we verify + mint here.
//
// Both rails mint PURCHASED (spend-only) coins. Nothing here ever credits the
// convertible "earned" bucket — purchased coins can never be cashed out.
//
// COMPLIANCE GUARDRAILS:
//   • IAP coins are minted ONLY against a verified receipt. We FAIL CLOSED — an
//     unverified or unconfigured receipt never credits coins.
//   • IAP coins buy digital content only (gifts/boosts). No route here touches
//     the wallet, utilities, or any real-world service.
//
// EXTERNAL SETUP (see PHASE10_PART1_CORRECTION doc):
//   • Apple: App Store Connect consumable products + shared secret (APPLE_IAP_SHARED_SECRET).
//   • Google: Play Console managed products + service account
//     (GOOGLE_PLAY_SA_JSON, GOOGLE_PLAY_PACKAGE_NAME) + `npm i googleapis`.
// Until those exist, /coins/purchase/iap returns 501 NOT_CONFIGURED (fail closed).

import { prisma } from "../../../prisma";
import {
  getCoinRates,
  coinsToNaira,
  creditPurchasedCoins,
  spendCoins,
} from "../../../shared/helpers/coin.helpers";

// ── Coin pack catalog ──────────────────────────────────────────────────────────
// The keys are the STORE SKUs — they must EXACTLY match the product IDs you
// register in App Store Connect and Google Play Console. `coins` is the source of
// truth for how many coins a pack grants; never trust a coin count from the client.
// For the NG (wallet/OPay) rail the same catalog is used, but the price is naira
// computed from AppConfig (see getCoinCatalog) — no store involved.
export const COIN_PACKS: Record<string, { coins: number; label: string }> = {
  "com.amril.app.coins.100": { coins: 100, label: "100 coins" },
  "com.amril.app.coins.500": { coins: 500, label: "500 coins" },
  "com.amril.app.coins.1000": { coins: 1000, label: "1,000 coins" },
  "com.amril.app.coins.2500": { coins: 2500, label: "2,500 coins" },
  "com.amril.app.coins.5000": { coins: 5000, label: "5,000 coins" },
  "com.amril.app.coins.10000": { coins: 10000, label: "10,000 coins" },
};

// ── Boost tiers ─────────────────────────────────────────────────────────────────
// A boost is a pure digital service (promote your own post). Cost is in coins,
// paid purchased-first-then-earned by the ledger. Tunable here.
const BOOST_TIERS: Record<string, { coins: number; hours: number; label: string }> = {
  hour6: { coins: 200, hours: 6, label: "6 hours" },
  day1: { coins: 500, hours: 24, label: "1 day" },
  day3: { coins: 1200, hours: 72, label: "3 days" },
};

// ─────────────────────────────────────────────────────────────────────────────
// PURCHASE — IAP (Apple / Google), server-verified  [non-NG rail]
// ─────────────────────────────────────────────────────────────────────────────
const verifyIapPurchase = async (req: any, res: any) => {
  const userId = req.user?.id;
  const { platform, productId, token } = req.body as {
    platform?: "apple" | "google";
    productId?: string;
    token?: string; // Apple: base64 receipt · Google: purchaseToken
  };

  try {
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!platform || !productId || !token) {
      return res.status(400).json({ error: "Missing platform, productId or token" });
    }
    if (!COIN_PACKS[productId]) {
      return res.status(400).json({ error: "Unknown product" });
    }

    const verification =
      platform === "apple"
        ? await verifyApple(token, productId)
        : await verifyGoogle(token, productId);

    if (verification.status === "NOT_CONFIGURED") {
      return res
        .status(501)
        .json({ error: "Coin purchases are not enabled yet", code: "NOT_CONFIGURED" });
    }
    if (!verification.verified) {
      return res
        .status(400)
        .json({ error: "Could not verify purchase", code: "VERIFY_FAILED" });
    }

    const pack = COIN_PACKS[productId];

    // Idempotency on the store transaction id: the client re-delivers the receipt
    // until it sees success, so credit exactly once.
    const existing = await prisma.coinPurchase.findUnique({
      where: { platformToken: verification.transactionId },
    });
    if (existing) {
      return res.json({
        success: existing.status === "SUCCESS",
        alreadyProcessed: true,
        coins: existing.coins,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      await creditPurchasedCoins(tx, userId, pack.coins);
      return tx.coinPurchase.create({
        data: {
          userId,
          source: platform === "apple" ? "apple_iap" : "google_play",
          coins: pack.coins,
          amount: 0, // store holds the cash; we record the grant, not the FX price
          currency: "USD",
          productId,
          platformToken: verification.transactionId,
          status: "SUCCESS",
          verified: true,
          rawReceipt: verification.raw ?? undefined,
        },
      });
    });

    return res.json({ success: true, coins: pack.coins, purchaseId: result.id });
  } catch (error: any) {
    console.error("=== IAP VERIFY ERROR ===", error);
    return res.status(500).json({ error: "Failed to process purchase" });
  }
};

// ── Apple receipt verification (legacy /verifyReceipt; simplest path) ──────────
async function verifyApple(
  receipt: string,
  expectedProductId: string,
): Promise<{ status: "OK" | "NOT_CONFIGURED"; verified: boolean; transactionId: string; raw?: any }> {
  const secret = process.env.APPLE_IAP_SHARED_SECRET;
  if (!secret) return { status: "NOT_CONFIGURED", verified: false, transactionId: "" };

  const body = JSON.stringify({
    "receipt-data": receipt,
    password: secret,
    "exclude-old-transactions": true,
  });
  const call = (url: string) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }).then(
      (r) => r.json() as Promise<any>,
    );

  // Production first; status 21007 means it's a sandbox receipt → retry sandbox.
  let data = await call("https://buy.itunes.apple.com/verifyReceipt");
  if (data?.status === 21007) data = await call("https://sandbox.itunes.apple.com/verifyReceipt");

  if (data?.status !== 0) return { status: "OK", verified: false, transactionId: "", raw: data };

  const items: any[] = data?.receipt?.in_app ?? [];
  const match = items.find((i) => i.product_id === expectedProductId);
  if (!match) return { status: "OK", verified: false, transactionId: "", raw: data };

  return {
    status: "OK",
    verified: true,
    transactionId: match.transaction_id,
    raw: { product_id: match.product_id, transaction_id: match.transaction_id },
  };
}

// ── Google Play verification ───────────────────────────────────────────────────
// Requires `npm i googleapis` + a service account (androidpublisher scope).
// Set GOOGLE_PLAY_SA_JSON (stringified key) and GOOGLE_PLAY_PACKAGE_NAME.
async function verifyGoogle(
  purchaseToken: string,
  productId: string,
): Promise<{ status: "OK" | "NOT_CONFIGURED"; verified: boolean; transactionId: string; raw?: any }> {
  const saJson = process.env.GOOGLE_PLAY_SA_JSON;
  const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  if (!saJson || !packageName) {
    return { status: "NOT_CONFIGURED", verified: false, transactionId: "" };
  }

  // ── Enable after `npm i googleapis` ──────────────────────────────────────────
  // import { google } from "googleapis";  (move to top of file)
  //
  // const auth = new google.auth.GoogleAuth({
  //   credentials: JSON.parse(saJson),
  //   scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  // });
  // const publisher = google.androidpublisher({ version: "v3", auth });
  // const { data } = await publisher.purchases.products.get({ packageName, productId, token: purchaseToken });
  // const verified = data.purchaseState === 0; // 0 = purchased
  // return { status: "OK", verified, transactionId: data.orderId ?? purchaseToken, raw: data };

  // Until googleapis is installed, treat as not configured (fail closed).
  return { status: "NOT_CONFIGURED", verified: false, transactionId: "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOST — promote your own post (digital service, coin sink; both rails feed it)
// ─────────────────────────────────────────────────────────────────────────────
const boostPost = async (req: any, res: any) => {
  const userId = req.user?.id;
  const { postId, tier } = req.body as { postId?: string; tier?: string };

  try {
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!postId || !tier || !BOOST_TIERS[tier]) {
      return res.status(400).json({ error: "Missing postId or invalid tier" });
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, userId: true, boostExpiresAt: true },
    });
    if (!post) return res.status(404).json({ error: "Post not found" });
    if (post.userId !== userId) {
      return res.status(403).json({ error: "You can only boost your own posts" });
    }

    const t = BOOST_TIERS[tier];
    const now = Date.now();
    const base =
      post.boostExpiresAt && post.boostExpiresAt.getTime() > now
        ? post.boostExpiresAt.getTime()
        : now;
    const expiresAt = new Date(base + t.hours * 60 * 60 * 1000);

    const result = await prisma.$transaction(async (tx) => {
      await spendCoins(tx, userId, t.coins); // purchased-first; throws INSUFFICIENT_COINS
      await tx.post.update({
        where: { id: postId },
        data: {
          isBoosted: true,
          boostExpiresAt: expiresAt,
          algorithmScore: { increment: 25 },
        },
      });
      return tx.coinBoost.create({
        data: { userId, postId, coinsSpent: t.coins, durationHrs: t.hours, expiresAt },
      });
    });

    return res.json({
      success: true,
      coinsSpent: t.coins,
      boostedUntil: expiresAt.toISOString(),
      boostId: result.id,
    });
  } catch (error: any) {
    if (error?.code === "INSUFFICIENT_COINS") {
      return res.status(400).json({
        error: "Not enough coins to boost",
        code: "INSUFFICIENT_COINS",
        available: error.available,
      });
    }
    console.error("=== BOOST ERROR ===", error);
    return res.status(500).json({ error: "Failed to boost post" });
  }
};

// ── Catalog ──────────────────────────────────────────────────────────────────
// One source of truth for both rails. `productId` is what the non-NG client
// queries the store for (store returns the localized price). `nairaWallet` is the
// NG price for the wallet/OPay rail. The client shows ONE of them based on region.
const getCoinCatalog = async (_req: any, res: any) => {
  const { purchaseRateNgn } = await getCoinRates();
  res.json({
    packs: Object.entries(COIN_PACKS).map(([id, p]) => ({
      productId: id, // store SKU (non-NG) + entityId for the payment engine (NG)
      coins: p.coins,
      label: p.label,
      nairaWallet: coinsToNaira(p.coins, purchaseRateNgn), // NG rail price
    })),
    boostTiers: Object.entries(BOOST_TIERS).map(([id, t]) => ({
      tier: id, coins: t.coins, hours: t.hours, label: t.label,
    })),
  });
};

export default { verifyIapPurchase, boostPost, getCoinCatalog };