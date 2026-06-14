import admin from "../../../config/firebase";
import { prisma } from "../../../prisma";

/// POST /chat/official/broadcast   (admin only)
/// Body: { title?, message }
///
/// Global announcement channel: a single Firestore collection every app user
/// subscribes to read-only. One write fans out to all clients via their
/// listeners (cheap — no per-user fan-out documents). The Flutter app injects a
/// synthetic "Amril Official" entry at the top of the chat list that opens this
/// stream.
export const postBroadcast = async (req: any, res: any) => {
  try {
    const adminId = req.user.id;
    const { title, message } = req.body;

    if (!message || String(message).trim() === "") {
      return res.status(400).json({ error: "message is required" });
    }

    const db = admin.firestore();

    // Snapshot the admin's display info for the message.
    const adminUser = await prisma.user.findUnique({
      where: { id: adminId },
      select: {
        name: true,
        userProfile: { select: { avatarUrl: true } },
      },
    });

    const ref = await db.collection("official_broadcast").add({
      title: title ?? null,
      text: String(message).trim(),
      type: "text",
      senderId: adminId,
      senderName: adminUser?.name ?? "Amril Official",
      senderAvatar: adminUser?.userProfile?.avatarUrl ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, id: ref.id });
  } catch (error: any) {
    console.error("postBroadcast error", error);
    return res.status(500).json({ error: "Failed to post broadcast" });
  }
};

export default { postBroadcast };
