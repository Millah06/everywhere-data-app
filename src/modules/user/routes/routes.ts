import { Router } from "express";
import { authMiddleware } from "../../../middleware/auth";
import getMeController from "../controllers/getMe.controller";
import searchUsersController from "../controllers/searchUser.controller";
import updateMeController from "../controllers/updateMe.controller";
import updateProfileController from "../controllers/updateProfile.controller";
import multer from "multer";


const  upload = multer({ storage: multer.memoryStorage(), 
  limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

const router = Router();

// ── USERS ─────────────────────────────────────────────────────────────────
router.get("/users/me", authMiddleware, getMeController.getMe);
router.patch("/users/me", authMiddleware, updateMeController.updateMe);
router.put(
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

// ── UPLOADS ───────────────────────────────────────────────────────────────
router.post(
  "/users/me/upload/profile-picture",
  authMiddleware,
  upload.single("image"),
  updateProfileController.uploadProfilePicture
);

router.post(
  "/users/me/upload/cover-photo",
  authMiddleware,
  upload.single("image"),
  updateProfileController.uploadCoverPhoto
);
router.post(
  "/users/me/toggle-private",
  authMiddleware,
  updateProfileController.togglePrivateAccount
);

router.post(
  "/users/me/toggle-allow-messages",
  authMiddleware,
  updateProfileController.toggleAllowFollowersToMessage
);

export default router;
