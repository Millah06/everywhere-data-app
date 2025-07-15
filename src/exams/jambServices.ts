import axios from "axios";
import {checkAuth} from "../webhook/utils/auth";

const jambServices = async (req: any, res: any) => {

  try {
    await checkAuth(req);

    const response = await axios.get("https://sandbox.vtpass.com/api/service-variations", {
      params: {serviceID : "jamb"},
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "secret-key": process.env.VTPASS_SECRET_KEY,
      },
    },);
    return res.status(200).json({ status: "success", response: response.data });
  } catch (error: any) {
    console.error("Verify Merchant Error:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Verifying Merchant", details: error?.response?.data });
  }
};

export default jambServices;


