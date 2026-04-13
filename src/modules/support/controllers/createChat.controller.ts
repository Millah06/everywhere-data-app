import admin from "firebase-admin";
import { prisma } from "../../../prisma";
import { FieldValue } from "firebase-admin/firestore";

const createOrGetChat = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });

    const chatRef = admin.firestore().collection("supportChats").doc();

    const adminUser = await prisma.user.findFirst({ where: { role: "admin" } });
    if (!adminUser) return res.status(500).json({ message: "Admin user not found" });

    await chatRef.set(
      {
        participants: FieldValue.arrayUnion(userId, adminUser.id),
        isClosed: false,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res
      .status(201)
      .json({ message: "Chat created successfully", chatId: chatRef.id, adminName: 'Support Team' });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
  createOrGetChat,
};