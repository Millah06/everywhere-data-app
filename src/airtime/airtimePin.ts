import axios from "axios";
import { checkAuth } from "../webhook/utils/auth";


const sendRechargeCard = async (req: any, res: any) => {
  try {
    await checkAuth(req); // Verify auth

    const { network, network_amount, quantity, name_on_card} = req.body;

    if (!network || !network_amount || !quantity || !name_on_card) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const response = await axios.post("https://sandbox.vtunaija.com.ng/api/rechargepin", {
      network: network,
      network_amount: network_amount,
      quantity: quantity,
      name_on_card: name_on_card,
    }, {
      headers: {
        Authorization: `Token ${process.env.VTUNAIJA_API_KEY}`,
        'Content-Type': 'application/json'
      },
    });

    return res.status(200).json({ status: "success", response: response.data });

  } catch (error: any) {
    console.error("sendAirtime error:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Airtime failed", details: error?.response?.data });
  }
};

export default sendRechargeCard;
