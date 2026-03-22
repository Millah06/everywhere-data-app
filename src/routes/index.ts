import { Router } from "express";
import utilityRouter from "../modules/utility/routes/routes";
import socialRouter from "../modules/social/routes/routes";
import marketPlaceRouter from "../modules/marketPlace/marketPlace.routes";
import adminRouter from "../modules/admin/routes/routes";
import kycRouter from "../modules/kyc/routes/routes";
import userRouter from "../modules/user/routes/routes";
import authRouter from "../modules/auth/routes/routes";
import walletRouter from "../modules/wallet/routes/routes";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.use(utilityRouter);
router.use(socialRouter);
router.use(marketPlaceRouter);
router.use(adminRouter);
router.use(kycRouter);
router.use(userRouter);
router.use(authRouter);
router.use(walletRouter);

// ── MIGRATION (one-off, protect this in prod!) ────────────────────────────
router.post("/admin/migrate", async (req: any, res: any) => {
  try {
    const { migrationRunner } = await import("../migration");
    const result = await migrationRunner();
    return res.json(result);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
});

export default router;
