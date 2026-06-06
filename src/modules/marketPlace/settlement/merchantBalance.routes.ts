import { Router } from "express";
import { authMiddleware } from "../../../middleware/auth";
import merchantBalanceController from "./merchantBalance.controller";

/**
 * Phase 6 — merchant balance read API.
 *
 * IMPORTANT: path is `/merchant/balance`, NOT `/vendor/balance`. The vendor
 * router has a `GET /vendor/:id` (getVendorById), which would otherwise match
 * `/vendor/balance` with id="balance" and return "Vendor not found". Keeping
 * this under /merchant avoids that collision regardless of mount order.
 *
 * Mounted in `src/routes/index.ts` via `router.use(merchantBalanceRoutes)`.
 */
const router = Router();

router.get("/merchant/balance", authMiddleware, merchantBalanceController.getBalance);

export default router;