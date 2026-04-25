import { prisma } from "../../../prisma";
import * as admin from "firebase-admin";
import { QueryDocumentSnapshot } from "firebase-admin/firestore";

const phonePattern = /(\+?\d[\d\s\-]{8,}\d)/;

const sendMessage = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { orderId } = req.params;
    const { message, imageUrl } = req.body; // imageUrl is optional

    if ((!message || message.trim() === "") && !imageUrl)
      return res
        .status(400)
        .json({ message: "Message or image is required" });

    if (message && phonePattern.test(message))
      return res
        .status(400)
        .json({ message: "Phone numbers are not allowed in chat" });

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const vendor = await prisma.vendor.findFirst({
      where: { id: order.vendorId},
    });
    
    const isBuyer = order.userId === userId;
    const isVendor = !!vendor;

    if (!isBuyer && !isVendor)
      return res.status(403).json({ message: "Unauthorized" });

    if (["completed", "cancelled"].includes(order.status)) {
      const config = await prisma.appConfig.findFirst();
      const closeHours = config?.chatCloseHours ?? 72;
      const closedAt = new Date(
        order.updatedAt.getTime() + closeHours * 60 * 60 * 1000,
      );
      if (new Date() > closedAt)
        return res
          .status(400)
          .json({ message: "Chat is closed for this order" });
    }

    const msgRef = await admin
      .firestore()
      .collection("orderChats")
      .doc(orderId)
      .collection("messages")
      .add({
        senderId: userId,
        senderName: isVendor ? vendor!.name : "Customer",
        message: message?.trim() ?? "",
        imageUrl: imageUrl ?? null,
        isAdmin: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.status(201).json({
      id: msgRef.id,
      orderId,
      senderId: userId,
      message: message?.trim() ?? "",
      imageUrl: imageUrl ?? null,
    });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getMessages = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const vendor = await prisma.vendor.findFirst({
      where: { id: order.vendorId, ownerId: userId },
    });
    const isBuyer = order.userId === userId;
    const isVendor = !!vendor;

    if (!isBuyer && !isVendor)
      return res.status(403).json({ message: "Unauthorized" });

    const snapshot = await admin
      .firestore()
      .collection("orderChats")
      .doc(orderId)
      .collection("messages")
      .orderBy("createdAt", "asc")
      .get();

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
