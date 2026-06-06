import { Router } from "express";
import { authMiddleware } from "../../../middleware/auth";
import merchantBalanceController from "./merchantBalance.controller";

/**
 * Phase 6 — merchant balance read API.
 *
 * New router (rather than editing the large marketPlace.routes.ts) — same
 * lower-risk pattern used for trust.routes.ts in Phase 4. Mounted in
 * `src/routes/index.ts` via `router.use(merchantBalanceRoutes)`.
 */
const router = Router();

router.get("/vendor/balance", authMiddleware, merchantBalanceController.getBalance);

export default router;