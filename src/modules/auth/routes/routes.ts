import { Router} from "express";
import loginController from "../controllers/login.controller";
import singUpController from "../controllers/singUp.controller";

const router = Router();

  // ── AUTH ──────────────────────────────────────────────────────────────────
  // Move sign-up/login to the backend so client just exchanges a custom token.
router.post("/auth/register", singUpController.register);
router.post("/auth/login", loginController.login);
router.post("/auth/refresh-claims", loginController.refreshClaims);


export default router;