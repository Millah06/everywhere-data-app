import axios from "axios";
import { checkAuth } from "../webhook/utils/auth";


const sendAirtime = async (req: any, res: any) => {
  try {
    await checkAuth(req); // Verify auth

    const { phoneNumber, amount, network, requestID} = req.body;

    if (!phoneNumber || !amount || !network || !requestID) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const response = await axios.post("https://sandbox.vtpass.com/api/pay", {
      request_id: requestID,
      serviceID: network,
      amount: amount,
      phone: phoneNumber,
    }, {
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "secret-key": process.env.VTPASS_SECRET_KEY,
      },
    });

    return res.status(200).json({ status: "success", response: response.data });

  } catch (error: any) {
    console.error("sendAirtime error:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Airtime failed", details: error?.response?.data });
  }
};

export default sendAirtime;
