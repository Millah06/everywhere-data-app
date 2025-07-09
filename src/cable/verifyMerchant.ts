import axios from "axios";
import {checkAuth} from "../webhook/utils/auth";

const verifyMerchant = async (req: any, res: any) => {

  const auth = Buffer.from(`${process.env.VTPASS_USERNAME}:${process.env.VTPASS_PASSWORD}`).toString("base64");

  try {
    await checkAuth(req);

    const {serviceID, smartCard} = req.body;

    if (!serviceID || !smartCard) {
      return res.status(400).json({error: "Missing required fields"});
    }

    const response = await axios.post("https://sandbox.vtpass.com/api/merchant-verify", {
      serviceID: serviceID,
      billersCode: smartCard,
    }, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });
    return {status: "success", data: response.data};
  } catch (error: any) {
    console.error("Verify Merchant Error:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Verifying Merchant", details: error?.response?.data });
  }
};

export default verifyMerchant;


