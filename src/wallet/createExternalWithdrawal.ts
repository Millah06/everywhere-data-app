import admin from "../webhook/utils/firebase";
import { prisma } from "../prisma";
import { checkAuth } from "../webhook/utils/auth";
import axios from "axios";

const fetchListOfBanks = async (req: any, res: any) => {
  try {
    const response = await axios.get(" https://api.paystack.co/bank?currency=NGN", {
      headers: { 
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
        "Content-Type": "application/json"
     }
    });
    res.json({ success: true, banks: response.data.data });
  } catch (error: any) {
    console.error("Error fetching banks:", error);
    res.status(500).json({ error: "Failed to fetch list of banks" });
  }
}

const resolveBankAccount = async (req: any, res: any) => {
  try {
    const { accountNumber, bankCode } = req.params;
    const response = await axios.get(
      `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
       {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
        "Content-Type": "application/json"
      }
      
    });
    res.json({ success: true, account: response.data.data });
  } catch (error: any) {
    console.error("Error resolving bank account:", error);
    throw new Error("Failed to resolve bank account");
  }
};

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
  fetchListOfBanks,
  resolveBankAccount,
};
