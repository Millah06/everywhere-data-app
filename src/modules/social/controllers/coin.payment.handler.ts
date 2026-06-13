// src/modules/social/controllers/coin.payment.handler.ts
//
// PHASE 10 — registers the "coin_purchase" handler with the universal payment
// engine, so a Nigerian buying coins flows through the EXACT same path as a
// marketplace order or dine-in order: the client opens PaymentSheet with
// entityType "coin_purchase", picks Wallet or OPay, the engine charges, and on
// SUCCESS this handler mints the coins. No bespoke coin payment endpoint needed.
//
// Mirrors the marketplace_order handler's contract:
//   • idempotent (webhook + recovery cron can both fire for one payment);
//   • derives the coin grant from the server-side catalog, never the client;
//   • validates the charged amount against the pack's expected naira, so a
//     tampered request (cheap amount, expensive pack) throws → wallet refunds.
//
// This file is imported for its side effect from the social routes file, which
// loads at startup — the same way dine-in registers its handler.

import { prisma } from "../../../prisma";
import { registerPaymentHandler } from "../../payment/payment.handler";
import { PAYMENT_PROVIDER } from "../../payment/payment.types";
import { COIN_PACKS } from "./coinController";
import {
  getCoinRates,
  coinsToNaira,
  creditPurchasedCoins,
} from "../../../shared/helpers/coin.helpers";

// entityType string — kept in sync with PAYMENT_ENTITY.COIN_PURCHASE added to
// payment.types.ts (see the Part 1 correction doc). Using the literal here keeps
// this module from needing the engine to be edited beyond the registry entry.
const COIN_PURCHASE = "coin_purchase";

registerPaymentHandler(COIN_PURCHASE, async (payment) => {
  // entityId carries the pack/SKU id the client chose.
  const packId: string = payment.entityId;
  const pack = COIN_PACKS[packId];
  if (!pack) {
    throw new Error(`coin_purchase: unknown pack "${packId}" (paymentId=${payment.id})`);
  }

  // Validate the money charged matches the pack price at the current NG rate.
  // The engine already proved the amount was really paid (wallet debit / OPay
  // query); here we ensure the client didn't pair a cheap amount with a big pack.
  const { purchaseRateNgn } = await getCoinRates();
  const expectedNaira = coinsToNaira(pack.coins, purchaseRateNgn);
  if (Math.abs(payment.amount - expectedNaira) > 1) {
    throw new Error(
      `coin_purchase: amount mismatch pack=${packId} expected=₦${expectedNaira} ` +
        `got=₦${payment.amount} (paymentId=${payment.id})`,
    );
  }

  // Idempotency: one CoinPurchase per Payment.id (unique platformToken).
  const existing = await prisma.coinPurchase.findUnique({
    where: { platformToken: payment.id },
  });
  if (existing && existing.status === "SUCCESS") return;

  const source =
    payment.provider === PAYMENT_PROVIDER.OPAY ? "opay_ngn" : "wallet_ngn";

  await prisma.$transaction(async (tx) => {
    await creditPurchasedCoins(tx, payment.userId, pack.coins);
    await tx.coinPurchase.upsert({
      where: { platformToken: payment.id },
      create: {
        userId: payment.userId,
        source: source as any,
        coins: pack.coins,
        amount: payment.amount,
        currency: "NGN",
        productId: packId,
        platformToken: payment.id,
        status: "SUCCESS",
        verified: true,
      },
      update: { status: "SUCCESS", verified: true },
    });
  });
});

export {}; // module loaded for its registration side effect