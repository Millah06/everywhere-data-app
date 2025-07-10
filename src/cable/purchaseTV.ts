import axios from "axios";
import {checkAuth} from "../webhook/utils/auth";

const purchaseTV = async (req: any, res: any) => {

  const auth = Buffer.from(`${process.env.VTPASS_USERNAME}:${process.env.VTPASS_PASSWORD}`).toString("base64");
  try {
    await checkAuth(req);

    const {requestID, serviceID, phoneNumber, variationCode, subscriptionType, smartCard} = req.body;

    if (!phoneNumber || !serviceID || !requestID || !variationCode || !subscriptionType) {
      return res.status(400).json({ error: "Missing required fields" });
      }

    const response = await axios.post("https://vtpass.com/api/pay", {
      request_id: requestID,
      serviceID: serviceID,
      billersCode: smartCard,
      variation_code: variationCode,
      phone: phoneNumber,
      subscription_type: subscriptionType,
      }, {
        headers: {
           Authorization: `Basic ${auth}`,
          },
      });

    return res.status(200).json({ status: "success", response: response.data });

  } catch (error: any) {
    console.error("Subscription Error:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Cable Subscription failed", details: error?.response?.data });
  }
};

export default purchaseTV;


