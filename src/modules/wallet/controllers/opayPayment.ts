import axios from "axios";

const initiateOpayCheckout = async (req: any, res: any) => {
  try {
    const url =
      "https://testapi.opaycheckout.com/api/v1/international/cashier/create";
    const payload = {
      amount: {
        total: 2000,
        currency: "NGN",
      },
      returnUrl: "https://your-return-url",
      callbackUrl: "https://your-call-back-url",
      cancelUrl: "https://your-cancel-url",
      displayName: "Amrili Digital Services Limited",
      customerVisitSource: "ANDROID",
      evokeOpay: true,
      expireAt: 300,
      sn: "PE462xxxxxxxx",
      product: {
        description: "description",
        name: "name",
      },
      payMethod: "OpayWalletNg",
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

    const { cashierUrl } = response.data.data;
    res.status(200).json({
      message: "OPay checkout initiated successfully.",
      url: cashierUrl,
    });
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
};

export default { initiateOpayCheckout };
