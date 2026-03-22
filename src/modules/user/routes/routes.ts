import { Router } from "express";
import { authMiddleware } from "../../../middleware/auth";
import getMeController from "../controllers/getMe.controller";
import searchUsersController from "../controllers/searchUser.controller";
import updateMeController from "../controllers/updateMe.controller";
import updateProfileController from "../controllers/updateProfile.controller";

const router = Router();

// ── USERS ─────────────────────────────────────────────────────────────────
router.get("/users/me", authMiddleware, getMeController.getMe);
router.patch("/users/me", authMiddleware, updateMeController.updateMe);
router.patch(
  "/users/me/profile",
  authMiddleware,
  updateProfileController.updateProfile,
);
router.patch(
  "/users/me/notification-token",
  authMiddleware,
  updateProfileController.updateNotificationToken,
);
router.get(
  "/users/referral-stats",
  authMiddleware,
  updateProfileController.getReferralStats,
);
router.get("/users/search", authMiddleware, searchUsersController.searchUsers); // you may want to add requireAdmin here

export default router;
