import { Router} from "express";
import loginController from "../controllers/login.controller";
import singUpController from "../controllers/singUp.controller";
import { socialAuth } from "../controllers/social";
import { setTransactionPin, verifyTransactionPin } from "../controllers/pin";
import { completeProfile } from "../controllers/complete-profile";
// In your auth router:
import { requestPinReset }     from '../controllers/request-pin-reset';
import { verifyPinOtp }        from '../controllers/verify-pin-otp';
import { resetPin }            from '../controllers/reset-pin';
import { requestPasswordReset } from '../controllers/request-password-reset';
import { resetPassword }       from '../controllers/reset-password';
import { verifyPasswordOtp } from "../controllers/verify-password-opt";


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


// PIN reset (authenticated)
router.post('/auth/request-pin-reset', requestPinReset);
router.post('/auth/verify-pin-otp',    verifyPinOtp);
router.post('/auth/reset-pin',         resetPin);

// Password reset (public — no auth middleware)
router.post('/auth/request-password-reset', requestPasswordReset);
router.post('/auth/reset-password',         resetPassword);
router.post('/auth/verify-password-otp',    verifyPasswordOtp);
// Also add the new verify-password-otp route:
// POST /auth/verify-password-otp  → same logic as verifyPinOtp but uses passwordResetOtpHash
// (quickest: copy verifyPinOtp, change the two field names)


export default router;