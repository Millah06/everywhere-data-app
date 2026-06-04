// src/modules/trust/trust.routes.ts
//
// PHASE 4 — Merchant Trust System
// Vendor-facing trust routes. Mounted in src/routes/index.ts alongside the other
// module routers (see EDITS/routes_index.patch.md). Admin trust routes live in
// src/modules/admin/routes/routes.ts.
//
// Multer is declared inline with memory storage + a 10MB limit — identical to
// every other route file in this project (users, social, marketPlace). The
// identity document is sent under the field name "image", matching the existing
// upload endpoints (/vendor/upload/cac, /users/me/upload/profile-picture, ...).
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import multer from "multer";
import { authMiddleware } from "../../middleware/auth";
import trustController from "./trust.controller";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const router = Router();

router.get(
  "/vendor/trust/status",
  authMiddleware,
  trustController.getTrustStatus,
);

router.post(
  "/vendor/trust/submit-identity",
  authMiddleware,
  upload.single("image"),
  trustController.submitIdentity,
);

router.post(
  "/vendor/trust/pay-fee",
  authMiddleware,
  trustController.payVerificationFee,
);

export default router;