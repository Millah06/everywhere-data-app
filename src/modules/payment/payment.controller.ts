// src/modules/payment/payment.controller.ts
//
// Backend-authoritative payment engine controller. The frontend never completes
// a purchase — it only reads the status the backend has decided.
//
// Endpoints:
//   POST /payment/create            (auth)  create + (wallet: execute | opay: cashierUrl)
//   POST /payment/wallet            (auth)  wallet path (PIN already verified client-side)
//   GET  /payment/:paymentId/status (auth)  poll; lazily re-queries OPay if pending
//   GET  /payment/pending           (auth)  unfinished payments for resume-recovery
//   POST /payment/webhook/opay      (PUBLIC) OPay callback — trigger only
//
// Source of truth for OPay = `opay.queryStatus()` (re-query), never the redirect
// and never the webhook body alone (spec §12/§13). Wallet = atomic debit here.

import { prisma } from "../../prisma";
import {
  PAYMENT_STATUS,
  PAYMENT_PROVIDER,
  PAYMENT_ENTITY,
  PAYMENT_EXPIRY_MINUTES,
  assertTransition,
  isTerminal,
  type PaymentStatus,
} from "./payment.types";
import * as opay from "./providers/opay.service";
import { debitWallet, debitWalletForUtility, refundWallet } from "./providers/wallet.payment";
import { dispatch } from "./payment.handler";
import { WalletService } from "../../shared/services/wallet.service";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Public-safe shape returned to the client. */
function publicPayment(p: any) {
  return {
    paymentId: p.id,
    status: p.status,
    provider: p.provider,
    amount: p.amount,
    currency: p.currency,
    entityType: p.entityType,
    entityId: p.entityId,
    cashierUrl: ((p.providerMeta as any)?.cashierUrl) || null,
    dispatchError: ((p.providerMeta as any)?.dispatchError) || null,
    // Delivery result (utility token/PIN/status) so the client can show a
    // receipt instantly without a trip to transaction history.
    delivery: ((p.providerMeta as any)?.delivery) || null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Detect "Payment table not migrated yet" and fail CLOSED (money path). */
function isMissingTable(e: any): boolean {
  return e?.code === "P2021" || e?.code === "P2022";
}
function tableGuard(res: any, e: any): boolean {
  if (isMissingTable(e)) {
    res.status(503).json({
      message:
        "Payment engine is not active yet (pending database migration). " +
        "Existing wallet checkout is unaffected.",
    });
    return true;
  }
  return false;
}

async function recordAttempt(
  paymentId: string,
  provider: string,
  status: string,
  providerRef?: string | null,
  response?: any,
) {
  try {
    await prisma.paymentAttempt.create({
      data: { paymentId, provider, status, providerRef: providerRef ?? null, response },
    });
  } catch {
    /* attempts are best-effort telemetry — never block the money path */
  }
}

async function setStatus(payment: any, to: PaymentStatus, extraMeta?: any) {
  assertTransition(payment.status, to);
  const providerMeta = extraMeta
    ? { ...((payment.providerMeta as any) ?? {}), ...extraMeta }
    : ((payment.providerMeta as any) ?? undefined);
  return prisma.payment.update({
    where: { id: payment.id },
    data: { status: to, providerMeta },
  });
}

/**
 * Mark a payment SUCCESS and run its business handler. Idempotent: if already
 * SUCCESS, just (re)dispatch (handlers are idempotent). A handler failure does
 * NOT revert SUCCESS — money has moved — it records `dispatchError` for manual
 * review and is retried by the recovery cron.
 */
async function fulfill(payment: any): Promise<any> {
  let p = payment;
  if (p.status !== PAYMENT_STATUS.SUCCESS) {
    p = await setStatus(p, PAYMENT_STATUS.SUCCESS, {
      webhookVerifiedAt: new Date().toISOString(),
    });
    await prisma.payment
      .update({ where: { id: p.id }, data: { webhookVerified: true } })
      .catch(() => {});
  }
  try {
    await dispatch(p);
    // Re-read so handler-written fields (e.g. utility delivery token/status) are
    // reflected in the response the client receives.
    const fresh = await prisma.payment.findUnique({ where: { id: p.id } });
    if (fresh) p = fresh;
    // clear any prior dispatch error
    if ((p.providerMeta as any)?.dispatchError) {
      p = await prisma.payment.update({
        where: { id: p.id },
        data: { providerMeta: { ...((p.providerMeta as any) ?? {}), dispatchError: null } },
      });
    }
  } catch (err: any) {
    p = await prisma.payment.update({
      where: { id: p.id },
      data: {
        providerMeta: {
          ...((p.providerMeta as any) ?? {}),
          dispatchError: String(err?.message || err),
        },
      },
    });
  }
  return p;
}

/**
 * Reconcile an OPay payment against OPay's authoritative status. Shared by the
 * status poll, the webhook, and the recovery cron — ONE place that decides.
 */
export async function reconcileOpayPayment(payment: any): Promise<any> {
  if (isTerminal(payment.status as PaymentStatus)) return payment;

  // Expire stale CREATED sessions (no money moved).
  if (payment.status === PAYMENT_STATUS.CREATED && payment.expiresAt) {
    if (new Date(payment.expiresAt).getTime() < Date.now()) {
      return setStatus(payment, PAYMENT_STATUS.EXPIRED);
    }
  }

  let p = payment;
  if (p.status === PAYMENT_STATUS.PENDING) {
    p = await setStatus(p, PAYMENT_STATUS.VERIFYING);
  }

  let q: opay.OpayQueryResult;
  try {
    q = await opay.queryStatus(p.id); // we use Payment.id as the OPay reference
  } catch (e: any) {
    await recordAttempt(p.id, PAYMENT_PROVIDER.OPAY, "query_error", null, {
      error: String(e?.message || e),
    });
    return p; // transient — recovery cron will retry
  }

  await recordAttempt(p.id, PAYMENT_PROVIDER.OPAY, q.status, q.orderNo, q.raw);

  if (q.status === "SUCCESS") {
    // Defensive amount check — never fulfill on a mismatched amount.
    if (q.amountNaira != null && Math.abs(q.amountNaira - p.amount) > 1) {
      return setStatus(p, PAYMENT_STATUS.FAILED, {
        failReason: `amount_mismatch expected=${p.amount} got=${q.amountNaira}`,
      });
    }
    return fulfill(p);
  }
  if (q.status === "FAILED") {
    return setStatus(p, PAYMENT_STATUS.FAILED, { failReason: "opay_failed" });
  }
  return p; // still PENDING/VERIFYING
}

// ── Create (shared by /create and /wallet) ─────────────────────────────────────

async function createPayment(req: any, res: any, forcedProvider?: string) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: "Unauthenticated" });

  const {
    provider: rawProvider,
    amount,
    entityType,
    entityId,
    clientRequestId,
    returnUrl,
    productName,
    meta,
  } = req.body || {};

  const provider = forcedProvider || rawProvider;

  // Validation.
  if (!provider || ![PAYMENT_PROVIDER.WALLET, PAYMENT_PROVIDER.OPAY].includes(provider)) {
    return res.status(400).json({ message: "Unsupported provider" });
  }
  if (typeof amount !== "number" || !(amount > 0)) {
    return res.status(400).json({ message: "Invalid amount" });
  }
  if (!entityType || !entityId) {
    return res.status(400).json({ message: "entityType and entityId are required" });
  }
  if (!clientRequestId) {
    return res.status(400).json({ message: "clientRequestId is required (idempotency)" });
  }

  try {
    // Idempotency — return the existing payment for a repeated clientRequestId.
    const existing = await prisma.payment.findUnique({ where: { clientRequestId } });
    if (existing) return res.json(publicPayment(existing));

    const expiresAt = new Date(Date.now() + PAYMENT_EXPIRY_MINUTES * 60 * 1000);

    let payment = await prisma.payment.create({
      data: {
        userId,
        amount,
        currency: "NGN",
        provider,
        status: PAYMENT_STATUS.CREATED,
        entityType,
        entityId,
        clientRequestId,
        returnUrl: returnUrl ?? null,
        providerMeta: meta ? { meta } : undefined,
        expiresAt,
      },
    });

    // ── Wallet: execute inline (debit → dispatch) ─────────────────────────────
    if (provider === PAYMENT_PROVIDER.WALLET) {
      const isUtility = entityType === PAYMENT_ENTITY.UTILITY;
      let debit: { ok: boolean; reason?: string; transactionId?: string };

      if (isUtility) {
        // Reward-aware debit (option B): uses calculateTransaction so reward
        // spend + bonus earn match the old utility flow. The reward plan is
        // stored on the Payment for the handler/webhook to finalise.
        const svc = (meta?.service as string) || "";
        const bonus = await WalletService.getBonusConfig();
        const bonusPercent =
          svc === "airtime" ? bonus.airtime
          : svc === "data" ? bonus.data
          : svc === "cable" ? bonus.cable
          : svc === "electricity" ? bonus.electric
          : 0;

        const u = await debitWalletForUtility({
          userId,
          productAmount: amount,
          useReward: meta?.useReward === true,
          isRecharge: meta?.isRecharge === true,
          bonusPercent,
          clientRequestId,
          humanRef: productName,
          metaData: { paymentId: payment.id, entityType, entityId },
          service: meta?.service || "",
        });
        debit = u;
        if (u.ok && u.rewardPlan) {
          payment = await prisma.payment.update({
            where: { id: payment.id },
            data: { providerMeta: { ...((payment.providerMeta as any) ?? {}), rewardPlan: u.rewardPlan } },
          });
        }
      } else {
        debit = await debitWallet({
          userId,
          amountNaira: amount,
          clientRequestId,
          humanRef: productName,
          metaData: { paymentId: payment.id, entityType, entityId },
        });
      }

      if (!debit.ok) {
        payment = await setStatus(payment, PAYMENT_STATUS.FAILED, {
          failReason: debit.reason,
        });
        await recordAttempt(payment.id, PAYMENT_PROVIDER.WALLET, "failed");
        return res.status(400).json({
          ...publicPayment(payment),
          message:
            debit.reason === "insufficient_balance"
              ? "Insufficient wallet balance"
              : "Wallet payment failed",
        });
      }

      await recordAttempt(payment.id, PAYMENT_PROVIDER.WALLET, "debited", debit.transactionId);

      // Dispatch the business action; refund if it throws (defence in depth —
      // dispatch is also idempotent so this rarely fires).
      try {
        payment = await fulfill(payment);
        if ((payment.providerMeta as any)?.dispatchError) {
          // Dispatch failed (e.g. no handler yet) → refund so no money is stranded.
          // For utility, refund the actual amount debited (reward-adjusted).
          const refundAmount =
            (payment.providerMeta as any)?.rewardPlan?.walletToDeduct ?? amount;
          await refundWallet({
            userId,
            amountNaira: refundAmount,
            clientRequestId,
            metaData: { paymentId: payment.id, reason: "dispatch_failed" },
          });
          payment = await prisma.payment.update({
            where: { id: payment.id },
            data: { status: PAYMENT_STATUS.REFUNDED },
          });
          return res.status(502).json({
            ...publicPayment(payment),
            message: "Payment received but could not be completed; it was refunded.",
          });
        }
      } catch (e: any) {
        if (tableGuard(res, e)) return;
        throw e;
      }
      return res.json(publicPayment(payment));
    }

    // ── OPay: create cashier session, return URL for the WebView ──────────────
    try {
      const created = await opay.createCashier({
        reference: payment.id,
        amountNaira: amount,
        returnUrl:
          returnUrl ||
          process.env.OPAY_DEFAULT_RETURN_URL ||
          "https://amril.app/checkout-success",
        productName: productName || "Amril order",
        customerVisitSource: meta?.platform || "ANDROID",
      });

      payment = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PAYMENT_STATUS.PENDING,
          providerRef: created.orderNo ?? payment.id,
          providerMeta: {
            ...((payment.providerMeta as any) ?? {}),
            cashierUrl: created.cashierUrl,
            opayOrderNo: created.orderNo ?? null,
          },
        },
      });
      await recordAttempt(payment.id, PAYMENT_PROVIDER.OPAY, "cashier_created", created.orderNo);
      return res.json(publicPayment(payment));
    } catch (e: any) {
      await setStatus(payment, PAYMENT_STATUS.FAILED, {
        failReason: "opay_create_failed",
        error: String(e?.message || e),
      }).catch(() => {});
      return res.status(502).json({ message: "Could not start OPay checkout. Please try again." });
    }
  } catch (e: any) {
    if (tableGuard(res, e)) return;
    console.error("[payment/create]", e);
    return res.status(500).json({ message: e.message });
  }
}

// ── Route handlers ─────────────────────────────────────────────────────────────

const create = (req: any, res: any) => createPayment(req, res);
const walletPay = (req: any, res: any) => createPayment(req, res, PAYMENT_PROVIDER.WALLET);

const getStatus = async (req: any, res: any) => {
  const userId = req.user?.id;
  const { paymentId } = req.params;
  try {
    const payment = await prisma.payment.findFirst({ where: { id: paymentId, userId } });
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    // Lazy reconcile: if it's an OPay payment still in flight, re-query OPay so
    // the poll itself can resolve it even before the webhook lands.
    if (
      payment.provider === PAYMENT_PROVIDER.OPAY &&
      !isTerminal(payment.status as PaymentStatus)
    ) {
      const updated = await reconcileOpayPayment(payment);
      return res.json(publicPayment(updated));
    }
    return res.json(publicPayment(payment));
  } catch (e: any) {
    if (tableGuard(res, e)) return;
    return res.status(500).json({ message: e.message });
  }
};

const getPending = async (req: any, res: any) => {
  const userId = req.user?.id;
  try {
    const pending = await prisma.payment.findMany({
      where: {
        userId,
        status: { in: [PAYMENT_STATUS.CREATED, PAYMENT_STATUS.PENDING, PAYMENT_STATUS.VERIFYING] },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    return res.json({ data: pending.map(publicPayment) });
  } catch (e: any) {
    if (tableGuard(res, e)) return;
    return res.status(500).json({ message: e.message });
  }
};

/**
 * OPay webhook — PUBLIC, no auth. It is a TRIGGER ONLY: we acknowledge fast,
 * verify the signature best-effort, then reconcile via the authoritative
 * `queryStatus`. We never credit from the webhook body.
 */
const opayWebhook = async (req: any, res: any) => {
  // Acknowledge immediately so OPay doesn't retry-storm.
  res.sendStatus(200);

  try {
    const sigOk = opay.verifyWebhookSignature(
      req.body,
      (req.headers["authorization"] as string) ||
        (req.headers["x-opay-signature"] as string),
    );
    const reference = opay.extractWebhookReference(req.body);
    if (!reference) return;

    const payment = await prisma.payment.findFirst({
      where: { OR: [{ id: reference }, { providerRef: reference }] },
    });
    if (!payment) return;

    await recordAttempt(payment.id, PAYMENT_PROVIDER.OPAY, "webhook", reference, {
      sigOk,
      body: req.body,
    });

    // Reconcile regardless of sigOk — queryStatus is the real authority, and a
    // failed signature check shouldn't strand a genuinely-paid order. (Forged
    // callbacks can't fake a SUCCESS at OPay, so they reconcile to PENDING.)
    await reconcileOpayPayment(payment);
  } catch (e: any) {
    if (isMissingTable(e)) return; // engine not migrated — ignore quietly
    console.error("[payment/webhook/opay]", e?.message || e);
  }
};

export default { create, walletPay, getStatus, getPending, opayWebhook };
export { reconcileOpayPayment as _reconcileOpayPayment };