import axios from "axios";
import { generateUUID } from "../../../../shared/utils/uuid";

const verifyMerchant = async (req: any, res: any) => {

  const auth = Buffer.from(`${process.env.VTPASS_USERNAME}:${process.env.VTPASS_PASSWORD}`).toString("base64");

  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const transferRef = generateUUID();

    const {serviceID, smartCard} = req.body;

    if (!serviceID || !smartCard) {
      return res.status(400).json({error: "Missing required fields"});
    }

    const response = await axios.post("https://vtpass.com/api/merchant-verify", {
      serviceID: serviceID,
      billersCode: smartCard,
    }, {
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "secret-key": process.env.VTPASS_SECRET_KEY,
      },
    });

    return res.status(200).json({ status: "success", response: response.data });
    
  } catch (error: any) {
    console.error("Verify Merchant Error:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Verifying Merchant", details: error?.response?.data });
  }
};

export default verifyMerchant;


