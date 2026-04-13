import admin from 'firebase-admin';
import {prisma} from '../../../prisma';

const getAllChats = async (req: any, res: any) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const chatsSnapshot = await admin.firestore().collection("supportChats").get();
    const chats = [];
    for (const doc of chatsSnapshot.docs) {
      const chatData = doc.data();
      if (chatData.participants.includes(req.user.id)) {
        chats.push({ id: doc.id, ...chatData });
      }
    }
    res.json(chats);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const adminSendMessage = async (req: any, res: any) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { chatId } = req.params;
    const { message } = req.body;

    if (!message || message.trim() === "")
      return res.status(400).json({ message: "Message cannot be empty" });

    

    const msgRef = await admin
      .firestore()
      .collection("supportChats")
      .doc(chatId)
      .collection("messages")
      .add({
        senderId: "admin",
        senderName: "Support",
        message: message.trim(),
        isAdmin: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res
      .status(201)
      .json({ id: msgRef.id, chatId, message: message.trim(), isAdmin: true });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const closedAndDeleteChat = async (req: any, res: any) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const { chatId } = req.params;

    const chatRef = admin.firestore().collection("supportChats").doc(chatId);
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) return res.status(404).json({ message: "Chat not found" });
    await chatRef.update({ isClosed: true });
    await chatRef.collection("messages").get().then((snapshot) => {
      const batch = admin.firestore().batch();
      snapshot.docs.forEach((doc) => batch.delete(doc.ref));
      return batch.commit();
    });
    await chatRef.delete();
    res.json({ message: "Chat closed and messages deleted successfully" });
  }
    catch (e: any) {
      res.status(401).json({ message: e.message });
    }
};

export default { getAllChats, adminSendMessage, closedAndDeleteChat };