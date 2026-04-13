import { prisma } from "../../../prisma";
import * as admin from "firebase-admin";
import { QueryDocumentSnapshot } from "firebase-admin/firestore";

const sendMessage = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { chatId } = req.params;

    const { message } = req.body;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });

    const chatRef = admin.firestore().collection("supportChats").doc(chatId);

    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) return res.status(404).json({ message: "Chat not found" });
    const chatData = chatDoc.data();
    if (chatData?.isClosed) {
      return res.status(400).json({ message: "Chat is closed" });
    }

    const msgRef = await chatRef.collection("messages").add({
      senderId: userId,
      senderName: user.name || "User",
      message: message.trim(),
      isAdmin: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({ message: "Message sent successfully", messageId: msgRef.id });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getMessages = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { chatId } = req.params;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });
    const chatRef = admin.firestore().collection("supportChats").doc(chatId);
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) return res.status(404).json({ message: "Chat not found" });
    const chatData = chatDoc.data();
    if (!chatData?.participants.includes(userId)) {
      return res.status(403).json({ message: "Unauthorized" });
    }
    const snapshot = await chatRef.collection("messages").orderBy("createdAt", "asc").get();
    const messages = snapshot.docs.map((doc: QueryDocumentSnapshot) => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.json(messages);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default { sendMessage, getMessages };
