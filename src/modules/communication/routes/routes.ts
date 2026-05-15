import { Router } from "express";
import { authMiddleware } from "../../../middleware/auth";
import { findByUsername } from "../controllers/addByUsername";
import { findByPhone } from "../controllers/addByPhone";
import { syncContacts } from "../controllers/syncContacts";




const router = Router();

// ── COMMUNICATION ───────────────────────────────────────────────────────────────
router.get('/chat/find-by-username', authMiddleware, findByUsername);

router.get('/chat/find-by-phone', authMiddleware, findByPhone);

router.post('/chat/sync-contacts', authMiddleware, syncContacts);

export default router;
