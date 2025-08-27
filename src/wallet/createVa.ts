import { Request, Response } from "express";
import axios from "axios";
import admin from "../webhook/utils/firebase";
import {checkAuth} from "../webhook/utils/auth";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET!;
const PAYSTACK_BASE_URL = "https://api.paystack.co";

const createVA = async (req: Request, res: Response): Promise<void> => {
  try {
    const uid = await checkAuth(req);
    const { email, name, phone } = req.body;

    // ✅ Create Paystack Customer
    const customerRes = await axios.post(`${PAYSTACK_BASE_URL}/customer`, {
      email,
      first_name: name.split(" ")[0],
      last_name: name.split(" ")[1] || "",
      phone
    }, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    });

    const customerId = customerRes.data.data.customer_code;

    // ✅ Create Dedicated Virtual Account with UID in metadata
    const vaRes = await axios.post(`${PAYSTACK_BASE_URL}/dedicated_account`, {
      customer: customerId,
      preferred_bank: "wema-bank",
      metadata: { uid }
    }, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    });

    const vaData = vaRes.data.data;

    // ✅ Save VA details to Firestore under users collection
    await admin.firestore().collection("users").doc(uid).set({
      balance: 0,
      reward: 0,  
      va: {
        account_name: vaData.account_name,
        account_number: vaData.account_number,
        bank: vaData.bank.name,
        status: "active",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });

    res.status(200).json({ success: true, data: vaData });
  } catch (error: any) {
    console.error("Error creating VA:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to create virtual account" });
  }
};


export default createVA;