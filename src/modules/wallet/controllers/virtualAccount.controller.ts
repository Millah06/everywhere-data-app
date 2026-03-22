import {prisma} from "../../../prisma"
import axios from "axios";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY!;
const paystackClient = axios.create({
  baseURL: "https://api.paystack.co",
  headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
});

/**
 * POST /virtual-accounts
 * Creates a dedicated virtual account for the user via Paystack DVA (Dedicated Virtual Account).
 * User must have completed KYC before this step.
 * Body: { preferredBank? }  — "wema-bank" | "test-bank" | "sterling-bank"
 */
export const createVirtualAccount = async (req: any, res: any) => {
  try {
    const userId = req.user!.id;

    // Prevent duplicate active accounts
    const existing = await prisma.virtualAccount.findFirst({
      where: { userId, status: "active" },
    });
    if (existing) {
      return res.status(409).json({
        message: "You already have an active virtual account.",
        account: existing,
      });
    }

    // Fetch user details needed for Paystack
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        email: true,
        phone: true,
        kyc: { select: { status: true } },
      },
    });

    if (!user) return res.status(404).json({ message: "User not found." });

    // KYC gate — recommended before assigning a DVA
    if (user.kyc?.status !== "verified") {
      return res.status(403).json({
        message: "KYC verification required before creating a virtual account.",
      });
    }

    // 1. Create a Paystack customer (idempotent — won't fail if already exists)
    const customerRes = await paystackClient.post("/customer", {
      email: user.email,
      first_name: user.name.split(" ")[0],
      last_name: user.name.split(" ").slice(1).join(" ") || user.name.split(" ")[0],
      phone: user.phone,
    });

    const customerCode = customerRes.data.data.customer_code;

    // 2. Assign a dedicated virtual account
    const dvaRes = await paystackClient.post("/dedicated_account", {
      customer: customerCode,
      preferred_bank: req.body.preferredBank ?? "wema-bank",
    });

    const dva = dvaRes.data.data;

    // 3. Persist
    const account = await prisma.virtualAccount.create({
      data: {
        userId,
        bankName: dva.bank.name,
        accountNumber: dva.account_number,
        status: "active",
      },
    });

    return res.status(201).json(account);
  } catch (e: any) {
    // Surface Paystack-specific errors clearly
    const paystackMessage = e.response?.data?.message;
    return res.status(500).json({
      message: paystackMessage ?? e.message,
    });
  }
};

/**
 * GET /virtual-accounts
 * Lists all virtual accounts for the authenticated user
 */
export const getMyVirtualAccounts = async (req: any, res: any) => {
  try {
    const accounts = await prisma.virtualAccount.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
    });
    return res.json(accounts);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * DELETE /virtual-accounts/:id
 * Deactivates a virtual account (soft delete)
 */
export const deactivateVirtualAccount = async (req: any, res: any) => {
  try {
    const { id } = req.params;

    const account = await prisma.virtualAccount.findFirst({
      where: { id, userId: req.user!.id },
    });

    if (!account) return res.status(404).json({ message: "Account not found." });
    if (account.status !== "active") {
      return res.status(400).json({ message: "Account is already inactive." });
    }

    const updated = await prisma.virtualAccount.update({
      where: { id },
      data: { status: "inactive" },
    });

    return res.json(updated);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default {
    createVirtualAccount,
    getMyVirtualAccounts,
    deactivateVirtualAccount,
}