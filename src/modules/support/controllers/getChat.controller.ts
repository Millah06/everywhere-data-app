import admin from "firebase-admin";
import { prisma } from "../../../prisma";

const getChat = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });
    const chatRef = admin.firestore().collection("supportChats").doc(userId);
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) return res.status(200).json({ message: "Chat not found" });
    const chatData = chatDoc.data();
    if (!chatData?.participants.includes(userId)) {
      return res.status(403).json({ message: "Unauthorized" });
    }
    res.json(chatData);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default { getChat };