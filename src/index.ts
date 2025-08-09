
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import * as admin from "firebase-admin";

import sendAirtime from "./airtime/sendAirtime";
import sendRechargeCard from "./airtime/airtimePin";
import buyData from "./data/buyData";
import verifyMerchant from "./cable/verifyMerchant";
import purchaseTV from "./cable/purchaseTV";
import verifyMeter from "./electricity/verifyMeter";
import purchaseElectric from "./electricity/purchaseElectric"
import purchaseSmile from "./data/purchaseSmile";
import jambServices from "./exams/jambServices";
// import other functions here too if needed
import createVA from "./wallet/createVa";
import paystackWebhook from "./webhook/utils/payStackWebhook";

dotenv.config();

const serviceAccount = JSON.parse(
  Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON!, "base64").toString("utf8")
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const app = express();
app.use(cors({origin: true}));
app.use(express.json());

app.post("/airtime/sendAirtime", sendAirtime);
app.post("/airtime/sendRecharge", sendRechargeCard);
app.post("/cable/purchaseTV", purchaseTV);
app.post("/cable/verifyMerchant", verifyMerchant);
app.post("/data/buyData", buyData);
app.post("/electricity/verifyMeter", verifyMeter);
app.post("/electricity/purchaseElectric", purchaseElectric);
app.post('/data/purchaseSmile', purchaseSmile);
app.post("/wallet/createVA", createVA);
app.post("/webhook/paystack", paystackWebhook);
app.get("/exams/jambServices", jambServices);


// add more like: app.post("/wallet/fund", handleFundWallet)

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});