import admin from "../../../config/firebase";

/// POST /chat/room/:roomId/respond  { action: 'accept' | 'decline' | 'block' }
///
/// Message-requests actions. Only the RECIPIENT of a pending request (i.e. the
/// participant who did NOT initiate it) may respond.
///   accept  → requestState = 'accepted' (chat moves to the normal inbox)
///   decline → delete the room (and its messages best-effort)
///   block   → requestState = 'blocked' (sender can no longer deliver)
export const respondToRequest = async (req: any, res: any) => {
  try {
    const myId = req.user.id;
    const { roomId } = req.params;
    const { action } = req.body;

    if (!["accept", "decline", "block"].includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const db = admin.firestore();
    const roomRef = db.collection("chat_room").doc(roomId);
    const snap = await roomRef.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Room not found" });
    }

    const room = snap.data() as any;
    const participants: string[] = room.participants || [];

    if (!participants.includes(myId)) {
      return res.status(403).json({ error: "Not a participant" });
    }

    // The responder must be the recipient, not the initiator.
    if (room.requestedBy === myId) {
      return res
        .status(403)
        .json({ error: "Only the recipient can respond to this request" });
    }

    if (action === "accept") {
      await roomRef.update({ requestState: "accepted" });
      return res.json({ success: true, roomId, requestState: "accepted" });
    }

    if (action === "block") {
      await roomRef.update({ requestState: "blocked", blockedBy: myId });
      return res.json({ success: true, roomId, requestState: "blocked" });
    }

    // decline → remove the room and its messages (best-effort batch).
    const messages = await roomRef.collection("messages").limit(400).get();
    const batch = db.batch();
    messages.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(roomRef);
    await batch.commit();

    return res.json({ success: true, roomId, deleted: true });
  } catch (error: any) {
    console.error("respondToRequest error", error);
    return res.status(500).json({ error: "Failed to respond to request" });
  }
};

export default { respondToRequest };
