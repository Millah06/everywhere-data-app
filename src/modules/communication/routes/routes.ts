import { Router } from "express";
import { authMiddleware, optionalAuthMiddleware } from "../../../middleware/auth";
import { findByUsername } from "../controllers/addByUsername";
import { findByPhone } from "../controllers/addByPhone";
import { syncContacts } from "../controllers/syncContacts";
import { createOrGetChatRoom } from "../controllers/getChatRoom.controller";
import { getChatUser } from "../controllers/getChatUser";
import { respondToRequest } from "../controllers/respondRequest.controller";




const router = Router();

// ── COMMUNICATION ───────────────────────────────────────────────────────────────
router.get('/chat/find-by-username',  findByUsername);

router.get('/chat/find-by-phone', findByPhone);

router.get('/chat/user/:userId', getChatUser);

router.post('/chat/sync-contacts', optionalAuthMiddleware, syncContacts);

router.post('/chat/create-or-get-room', authMiddleware, createOrGetChatRoom);

router.post('/chat/room/:roomId/respond', authMiddleware, respondToRequest);

export default router;
