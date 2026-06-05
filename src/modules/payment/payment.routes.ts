// src/modules/payment/payment.routes.ts
//
// Routes for the payment engine. Declares full paths so it mounts flat in
// routes/index.ts via `router.use(paymentRoutes)`, like the other module
// routers (e.g. trust.routes.ts).
//
// The webhook is intentionally PUBLIC (no authMiddleware) — OPay's servers call
// it. It is HMAC-checked and, more importantly, re-queries OPay before moving
// money (see payment.controller.ts).

import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import paymentController from "./payment.controller";

const router = Router();

// Authenticated user payment surface.
router.post("/payment/create", authMiddleware, paymentController.create);
router.post("/payment/wallet", authMiddleware, paymentController.walletPay);
router.get("/payment/pending", authMiddleware, paymentController.getPending);
router.get("/payment/:paymentId/status", authMiddleware, paymentController.getStatus);

// Public OPay callback — no auth, HMAC-verified + re-queried.
router.post("/payment/webhook/opay", paymentController.opayWebhook);

export default router;