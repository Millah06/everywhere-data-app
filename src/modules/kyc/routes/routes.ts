import { Router} from "express";
import { authMiddleware } from "../../../middleware/auth";
import kycController from "../controllers/kyc.controller";

const router = Router();

  // ── KYC ───────────────────────────────────────────────────────────────────
router.get("/kyc", authMiddleware, kycController.getKycStatus);
router.post("/kyc/submit", authMiddleware, kycController.submitKyc);


export default router;