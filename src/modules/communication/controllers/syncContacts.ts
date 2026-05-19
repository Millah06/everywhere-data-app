import { prisma } from "../../../prisma";

export const syncContacts = async (req: any, res: any) => {
  const { contacts } = req.body;

  const currntUserId = req.user.id;

  if (!Array.isArray(contacts)) {
    return res.status(400).json({
      message: "Contacts must be an array",
    });
  }

  // normalize + deduplicate
  const normalizedNumbers = [
    ...new Set(
      contacts
        .map((p: string) =>
          p
            .replace(/\s/g, "")
            .replace(/-/g, "")
            .replace(/\(/g, "")
            .replace(/\)/g, ""),
        )
        .filter(Boolean),
    ),
  ];

  if (normalizedNumbers.length === 0) {
    return res.json({
      users: [],
    });
  }

  const users = await prisma.user.findMany({
    where: {
      ...(currntUserId ? { id: { not: currntUserId } } : {}), // exclude current user
      phone: {
        in: normalizedNumbers,
      },
    },
    select: {
      id: true,
      firebaseUid: true,
      phone: true,
      userProfile: {
        select: {
          userName: true,
          avatarUrl: true,
        },
      },
      name: true,
    },
  });

  const formattedUsers = users.map((user) => ({
    id: user.id,
    name: user.name,
    username: user.userProfile?.userName,
    avatarUrl: user.userProfile?.avatarUrl,
    phone: user.phone,
  }));

  return res.json({
    users: formattedUsers,
  });
};

export default {
  syncContacts,
};
