import { prisma } from "../../../prisma";

/// GET /chat/user/:userId
/// Resolve a Postgres User.id to a lightweight profile card. Used by the chat
/// QR flow: after scanning amril.app/u/:id we show who you're about to message
/// before creating the room. Public (no auth) so a logged-out scan still works.
export const getChatUser = async (req: any, res: any) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        userProfile: {
          select: {
            userName: true,
            avatarUrl: true,
            isVerified: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        userName: user.userProfile?.userName ?? null,
        avatarUrl: user.userProfile?.avatarUrl ?? null,
        verified: user.userProfile?.isVerified ?? false,
      },
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({ message: "Something went wrong" });
  }
};

export default { getChatUser };
