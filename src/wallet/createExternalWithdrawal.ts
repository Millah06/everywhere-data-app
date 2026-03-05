import admin from "../webhook/utils/firebase";
import { prisma } from "../prisma";
import { checkAuth } from "../webhook/utils/auth";

const createExternalWithdrawal = async (req: any, res: any) => {
  try {
    const userId = await checkAuth(req);
    const { amount, method, details } = req.body;
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
  createExternalWithdrawal,
};
