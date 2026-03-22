import { prisma } from "../../../prisma";


/**
 * PATCH /users/me
 * Update basic user fields: name, phone
 */
export const updateMe = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { name, phone } = req.body;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(name && { name }),
        ...(phone && { phone }),
      },
      select: { id: true, name: true, phone: true, updatedAt: true },
    });

    return res.json(updated);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default {
    updateMe
}