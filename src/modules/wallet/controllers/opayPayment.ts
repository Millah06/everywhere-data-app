import axios from "axios";
import { nanoid } from "nanoid";

const initiateOpayCheckout = async (req: any, res: any) => {
  try {
    const url =
      "https://testapi.opaycheckout.com/api/v1/international/cashier/create";
    const payload = {
      reference: nanoid().toUpperCase().slice(0, 12), // Unique reference for the transaction
      amount: {
        total: 2000,
        currency: "NGN",
      },
      returnUrl: "https://amrili.com/checkout-success",
      displayName: "Amrili Digital Services Limited",
      customerVisitSource: "ANDROID",
      evokeOpay: true,
      expireAt: 300,
      sn: "PE462239089403840840038993",
      product: {
        description: "description",
        name: "amril gifting",
      },
      payMethod: "OpayWalletNg",
      country: "NG",
    };

    //Authorization: Bearer {PublicKey}
    //MerchantId   : 256612345678901

    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer OPAYPUB17795318006960.42281797604856775",
      MerchantId: "256626052384533",
    };

    //I will return the cashierUrl to the frontend so that the user can be redirected to the OPay checkout page

    const response = await axios.post(url, payload, { headers });

    res.status(200).json({
      message: "OPay checkout initiated successfully.",
      data: response.data,
    });
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
};

export default { initiateOpayCheckout };
