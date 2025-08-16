import axios from "axios";
import {checkAuth} from "../webhook/utils/auth";

const purchaseElectric = async (req: any, res: any) => {
  try {
    await checkAuth(req);

    const {requestID, serviceID, phoneNumber, meterNumber, meterType, amount, quantity} = req.body;

    if (!phoneNumber || !serviceID || !requestID || !meterType) {
      return res.status(400).json({ error: "Missing required fields" });
      }

    const response = await axios.post("https://sandbox.vtpass.com/api/pay", {
      request_id: requestID,
      serviceID: serviceID,
      billersCode: meterNumber !== undefined ? meterNumber : undefined,
      amount: amount,
      phone: phoneNumber,
      variation_code: meterType,
      ...(quantity && {quantity})
      }, {
        headers: {
          "api-key": process.env.VTPASS_API_KEY,
          "secret-key": process.env.VTPASS_SECRET_KEY,
           
          },
      });

    return res.status(200).json({ status: "success", response: response.data });

  } catch (error: any) {
    console.error("Subscription Error:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Cable Subscription failed", details: error?.response?.data });
  }
};

export default purchaseElectric;