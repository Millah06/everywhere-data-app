import { prisma } from "../../../prisma";
export const updateLeaderboardVisibility = async (req: any, res: any) => {
  const userId = req.user?.id;
  const { hide } = req.body;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (typeof hide !== "boolean") return res.status(400).json({ error: "hide must be boolean" });
  await prisma.user.update({ where: { id: userId }, data: { hideFromLeaderboard: hide } });
  return res.json({ success: true, hideFromLeaderboard: hide });
};