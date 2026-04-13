import {Router} from "express";
import { authMiddleware } from "../../../middleware/auth";
import sendMessageController from "../controllers/sendMessage.controller";
import getChatController from "../controllers/getChat.controller";
import createChatController from "../controllers/createChat.controller";
const router = Router();

router.post("/support/chats/:chatId/messages", authMiddleware, sendMessageController.sendMessage);
router.get("/support/chats/:chatId/messages", authMiddleware, sendMessageController.getMessages);
router.get("/support/chats/:chatId", authMiddleware, getChatController.getChat);
router.post("/support/chats", authMiddleware, createChatController.createOrGetChat);
export default router;