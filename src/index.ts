
import express from "express";
import cors from "cors";

import sendAirtime from "./airtime/sendAirtime";
import buyData from "./data/buyData";
import verifyMerchant from "./cable/verifyMerchant";
import purchaseTV from "./cable/purchaseTV";
import verifyMeter from "./electricity/verifyMeter";
import purchaseElectric from "./electricity/purchaseElectric"
// import other functions here too if needed

const app = express();
app.use(cors({origin: true}));
app.use(express.json());

app.post("/airtime/sendAirtime", sendAirtime);
app.post("/cable/purchaseTV", purchaseTV);
app.post("/cable/verifyMerchant", verifyMerchant);
app.post("/data/buyData", buyData);
app.post("electricity/verifyMeter", verifyMeter);
app.post("/electricity/purchaseElectric", purchaseElectric)

// add more like: app.post("/wallet/fund", handleFundWallet)

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});