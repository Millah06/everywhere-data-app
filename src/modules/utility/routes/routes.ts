import {Router} from "express";
import sendAirtimeSecure from "../controllers/airtime/sendAirtime";
import sendRechargeCard from "../controllers/airtime/airtimePin";
import purchaseSecureTv from "../controllers/cable/purchaseTV";
import buyDataSecure from "../controllers/dataPurchase/buyData";
import paystackWebhook from "../../wallet/utils/payStackWebhook";
import createVA from "../../wallet/controllers/createVa";
import verifyMeter from "../controllers/electricity/verifyMeter";
import jambServices from "../controllers/exams/jambServices";
import purchaseSmile from "../controllers/dataPurchase/purchaseSmile";
import verifyMerchant from "../controllers/cable/verifyMerchant";
import purchaseSecureElectric from "../controllers/electricity/purchaseElectric";
import transactionStatus from "../../wallet/controllers/transactionStaatus";


const router = Router();

router.post("/airtime/sendAirtime", sendAirtimeSecure);
router.post("/airtime/sendRecharge", sendRechargeCard);
router.post("/cable/purchaseTV", purchaseSecureTv);
router.post("/cable/verifyMerchant", verifyMerchant);
router.post("/data/buyData", buyDataSecure);
router.post("/electricity/verifyMeter", verifyMeter);
router.post("/electricity/purchaseElectric", purchaseSecureElectric);
router.post('/data/purchaseSmile', purchaseSmile);
router.post("/wallet/createVA", createVA);
router.post("/webhook/paystack", paystackWebhook);
router.get("/exams/jambServices", jambServices);
router.get('/transactions/status/:transactionId', transactionStatus);


export default router;