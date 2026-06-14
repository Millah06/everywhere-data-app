import admin from "firebase-admin";
import { prisma } from "../../../prisma";



export const createOrGetChatRoom = async (req: any, res: any) => {
  try {
    const myId = req.user.id;
    const { otherUserId, initiatedVia } = req.body;

    const db = admin.firestore();

    if (!otherUserId) {
      return res.status(400).json({
        error: "otherUserId is required",
      });
    }

    if (myId === otherUserId) {
      return res.status(400).json({
        error: "Cannot create chat with yourself",
      });
    }

    // Message-requests policy: a chat started from a phone contact or a known
    // number lands directly in the recipient's inbox; one started from a
    // username / profile / QR goes to their "Requests" until accepted.
    const directVias = new Set(["contact", "phone"]);
    const requestState = directVias.has(String(initiatedVia))
      ? "accepted"
      : "pending";

    // Check existing room
    const existingRooms = await db
      .collection("chat_room")
      .where("participants", "array-contains", myId)
      .get();

    for (const doc of existingRooms.docs) {
      const participants = doc.data().participants || [];

      if (participants.includes(otherUserId)) {
        return res.json({
          success: true,
          roomId: doc.id,
          existing: true,
        });
      }
    }

    // Get users from Prisma
    const myUser = await prisma.user.findUnique({
      where: { id: myId },
      select: {
        id: true,
        name: true,
        userProfile: {
            select: {
                avatarUrl: true,
            }
        }
      },
    });

    const otherUser = await prisma.user.findUnique({
      where: { id: otherUserId },
      select: {
        id: true,
        name: true,
        userProfile: {
            select: {
                avatarUrl: true,
            }
        }
      },
    });

    if (!myUser || !otherUser) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    // Create room
    const roomRef = db.collection("chat_room").doc();

    await roomRef.set(
      {
        type: "p2p",

        participants: [myId, otherUserId],

        participantInfo: {
          [myId]: {
            name: myUser.name || "Unknown User",
            avatar: myUser.userProfile?.avatarUrl || null,
          },

          [otherUserId]: {
            name: otherUser.name || "Unknown User",
            avatar: otherUser.userProfile?.avatarUrl || null,
          },
        },

        lastMessage: "",
        lastMessageType: "text",
        lastMessageTime: null,

        // Message-requests metadata.
        //  requestState: 'accepted' | 'pending' | 'blocked'
        //  requestedBy:  who initiated (so the recipient, not the sender, sees
        //                the request and can accept/decline).
        requestState,
        requestedBy: myId,
        initiatedVia: initiatedVia ?? "username",

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return res.json({
      success: true,
      roomId: roomRef.id,
      existing: false,
    });
  } catch (error: any) {
    console.error("Create/Get P2P Room Error:", error);

    return res.status(500).json({
      error: "Failed to create or get room",
      message: error.message,
    });
  }
};