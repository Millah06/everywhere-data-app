import { Router} from "express";
import loginController from "../controllers/login.controller";
import singUpController from "../controllers/singUp.controller";
import { socialAuth } from "../controllers/social";
import { setTransactionPin, verifyTransactionPin } from "../controllers/pin";
import { completeProfile } from "../controllers/complete-profile";

const router = Router();

  // ── AUTH ──────────────────────────────────────────────────────────────────
  // Move sign-up/login to the backend so client just exchanges a custom token.
router.post("/auth/register", singUpController.register);
router.post("/auth/login", loginController.login);
router.post("/auth/refresh-claims", loginController.refreshClaims);
router.post('/auth/social', socialAuth);

router.post('/auth/set-pin', setTransactionPin);
router.post('/auth/verify-pin', verifyTransactionPin);
router.post('/auth/complete-profile', completeProfile);


export default router;