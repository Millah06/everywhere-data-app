import admin from "../../../config/firebase";
import { prisma } from "../../../prisma";

/// Group chat controllers. Groups live in the same Firestore `chat_room`
/// collection as p2p rooms, distinguished by `type: "group"` with:
///   participants:    string[] (Postgres user ids)
///   participantInfo: { [id]: { name, avatar } }
///   roles:           { [id]: 'owner' | 'admin' | 'member' }
///   groupName, groupAvatar
/// Messages reuse the existing chat_room/{id}/messages subcollection.

const FIRESTORE = () => admin.firestore();

async function fetchUserInfos(ids: string[]) {
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      userProfile: { select: { avatarUrl: true } },
    },
  });
  const info: Record<string, { name: string; avatar: string | null }> = {};
  const roles: Record<string, string> = {};
  for (const u of users) {
    info[u.id] = { name: u.name ?? "Unknown", avatar: u.userProfile?.avatarUrl ?? null };
  }
  return { info, roles, foundIds: users.map((u) => u.id) };
}

/// POST /chat/group  { name, memberIds: string[], avatarUrl? }
export const createGroup = async (req: any, res: any) => {
  try {
    const myId = req.user.id;
    const { name, memberIds, avatarUrl } = req.body;

    if (!name || String(name).trim() === "") {
      return res.status(400).json({ error: "Group name is required" });
    }
    if (!Array.isArray(memberIds) || memberIds.length < 1) {
      return res.status(400).json({ error: "Pick at least one member" });
    }

    // Owner + unique members.
    const participants = Array.from(new Set<string>([myId, ...memberIds]));
    const { info, foundIds } = await fetchUserInfos(participants);

    if (foundIds.length !== participants.length) {
      return res.status(400).json({ error: "Some users were not found" });
    }

    const roles: Record<string, string> = {};
    for (const id of participants) roles[id] = id === myId ? "owner" : "member";

    const ref = FIRESTORE().collection("chat_room").doc();
    await ref.set({
      type: "group",
      participants,
      participantInfo: info,
      roles,
      groupName: String(name).trim(),
      groupAvatar: avatarUrl ?? null,
      createdBy: myId,
      requestState: "accepted", // groups skip the request gate
      lastMessage: "",
      lastMessageType: "text",
      lastMessageTime: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, roomId: ref.id });
  } catch (e: any) {
    console.error("createGroup error", e);
    return res.status(500).json({ error: "Failed to create group" });
  }
};

async function loadRoomAsAdmin(roomId: string, myId: string) {
  const ref = FIRESTORE().collection("chat_room").doc(roomId);
  const snap = await ref.get();
  if (!snap.exists) return { error: "Group not found", status: 404 as const };
  const room = snap.data() as any;
  if (room.type !== "group") return { error: "Not a group", status: 400 as const };
  const roles = room.roles || {};
  if (!["owner", "admin"].includes(roles[myId])) {
    return { error: "Admins only", status: 403 as const };
  }
  return { ref, room };
}

/// POST /chat/group/:roomId/members  { memberIds: string[] }
export const addGroupMembers = async (req: any, res: any) => {
  try {
    const myId = req.user.id;
    const { roomId } = req.params;
    const { memberIds } = req.body;
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: "memberIds required" });
    }

    const loaded = await loadRoomAsAdmin(roomId, myId);
    if ("error" in loaded) return res.status(loaded.status).json({ error: loaded.error });
    const { ref, room } = loaded;

    const current: string[] = room.participants || [];
    const toAdd = memberIds.filter((id: string) => !current.includes(id));
    if (toAdd.length === 0) return res.json({ success: true, added: 0 });

    const { info } = await fetchUserInfos(toAdd);
    const updates: any = {
      participants: admin.firestore.FieldValue.arrayUnion(...toAdd),
    };
    for (const id of toAdd) {
      updates[`participantInfo.${id}`] = info[id] ?? { name: "Unknown", avatar: null };
      updates[`roles.${id}`] = "member";
    }
    await ref.update(updates);
    return res.json({ success: true, added: toAdd.length });
  } catch (e: any) {
    console.error("addGroupMembers error", e);
    return res.status(500).json({ error: "Failed to add members" });
  }
};

/// DELETE /chat/group/:roomId/members/:userId
export const removeGroupMember = async (req: any, res: any) => {
  try {
    const myId = req.user.id;
    const { roomId, userId } = req.params;

    const loaded = await loadRoomAsAdmin(roomId, myId);
    if ("error" in loaded) return res.status(loaded.status).json({ error: loaded.error });
    const { ref, room } = loaded;

    if (room.roles?.[userId] === "owner") {
      return res.status(400).json({ error: "Cannot remove the owner" });
    }

    await ref.update({
      participants: admin.firestore.FieldValue.arrayRemove(userId),
      [`participantInfo.${userId}`]: admin.firestore.FieldValue.delete(),
      [`roles.${userId}`]: admin.firestore.FieldValue.delete(),
    });
    return res.json({ success: true });
  } catch (e: any) {
    console.error("removeGroupMember error", e);
    return res.status(500).json({ error: "Failed to remove member" });
  }
};

/// POST /chat/group/:roomId/leave
export const leaveGroup = async (req: any, res: any) => {
  try {
    const myId = req.user.id;
    const { roomId } = req.params;
    const ref = FIRESTORE().collection("chat_room").doc(roomId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Group not found" });
    const room = snap.data() as any;
    const participants: string[] = room.participants || [];
    if (!participants.includes(myId)) {
      return res.status(403).json({ error: "Not a member" });
    }

    // If the owner leaves and others remain, hand ownership to the first member.
    const updates: any = {
      participants: admin.firestore.FieldValue.arrayRemove(myId),
      [`participantInfo.${myId}`]: admin.firestore.FieldValue.delete(),
      [`roles.${myId}`]: admin.firestore.FieldValue.delete(),
    };
    if (room.roles?.[myId] === "owner") {
      const next = participants.find((id) => id !== myId);
      if (next) updates[`roles.${next}`] = "owner";
    }
    await ref.update(updates);
    return res.json({ success: true });
  } catch (e: any) {
    console.error("leaveGroup error", e);
    return res.status(500).json({ error: "Failed to leave group" });
  }
};

/// PATCH /chat/group/:roomId  { name?, avatarUrl? }
export const updateGroup = async (req: any, res: any) => {
  try {
    const myId = req.user.id;
    const { roomId } = req.params;
    const { name, avatarUrl } = req.body;

    const loaded = await loadRoomAsAdmin(roomId, myId);
    if ("error" in loaded) return res.status(loaded.status).json({ error: loaded.error });
    const { ref } = loaded;

    const updates: any = {};
    if (typeof name === "string" && name.trim()) updates.groupName = name.trim();
    if (typeof avatarUrl === "string") updates.groupAvatar = avatarUrl;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }
    await ref.update(updates);
    return res.json({ success: true });
  } catch (e: any) {
    console.error("updateGroup error", e);
    return res.status(500).json({ error: "Failed to update group" });
  }
};

export default {
  createGroup,
  addGroupMembers,
  removeGroupMember,
  leaveGroup,
  updateGroup,
};
