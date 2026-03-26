import admin from 'firebase-admin';
import {prisma} from '../../../prisma';

const contactSupport = async (req: any, res:any) => {

    const userId = req.user.id;

     

     

};

const adminSendMessage = async (req: any, res: any) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { orderId } = req.params;
    const { message } = req.body;

    if (!message || message.trim() === "")
      return res.status(400).json({ message: "Message cannot be empty" });

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const msgRef = await admin
      .firestore()
      .collection("supportChats")
      .doc(orderId)
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
      .json({ id: msgRef.id, orderId, message: message.trim(), isAdmin: true });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};
