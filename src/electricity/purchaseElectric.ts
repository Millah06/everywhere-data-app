import express from "express";
import axios from "axios";
import {checkAuth} from "../webhook/utils/auth";

const router = express.Router();

router.post("/purchaseTV", async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const {requestID, serviceID, phoneNumber, meterNumber, meterType, amount} = req.body;

    if (!phoneNumber || !serviceID || !requestID || !meterNumber || !meterType) {
      return res.status(400).json({ error: "Missing required fields" });
      }

    const response = await axios.post("https://vtpass.com/api/pay", {
      request_id: requestID,
      serviceID: serviceID,
      billersCode: meterNumber,
      amount: amount,
      phone: phoneNumber,
      variation_code: meterType,
      }, {
        headers: {
          "api-key": process.env.VTPASS_API_KEY,
          "secret-key": process.env.VTPASS_SECRET_KEY,
          "Content-Type": "application/json",
          },
      });

    return { status: "success", data: response.data };

  } catch (error: any) {
    console.error("Subscription Error:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Cable Subscription failed", details: error?.response?.data });
  }
});

export default router;