import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer"; 
import * as admin from "firebase-admin";

import sendAirtimeSecure from "./airtime/sendAirtime";
import sendRechargeCard from "./airtime/airtimePin";
import buyDataSecure from "./data/buyData";
import verifyMerchant from "./cable/verifyMerchant";
import purchaseTV from "./cable/purchaseTV";
import verifyMeter from "./electricity/verifyMeter";
import purchaseElectric from "./electricity/purchaseElectric"
import purchaseSmile from "./data/purchaseSmile";
import jambServices from "./exams/jambServices";
// import other functions here too if needed
import createVA from "./wallet/createVa";
import paystackWebhook from "./webhook/utils/payStackWebhook";
import transactionStatus from "./wallet/transactionStaatus";
 

// Import social controllers
import socialController from "./controllers/socialController";
import rewardController from "./controllers/rewardController";
import { authMiddleware } from "./middleware/auth";
import { uploadPostImage } from "./cludfareServices/uploadImage";
   

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
 
// Congigure multer for file uploads

const upload = multer({ storage: multer.memoryStorage(), 
  limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

app.post("/airtime/sendAirtime", sendAirtimeSecure);
app.post("/airtime/sendRecharge", sendRechargeCard);
app.post("/cable/purchaseTV", purchaseTV);
app.post("/cable/verifyMerchant", verifyMerchant);
app.post("/data/buyData", buyDataSecure);
app.post("/electricity/verifyMeter", verifyMeter);
app.post("/electricity/purchaseElectric", purchaseElectric);
app.post('/data/purchaseSmile', purchaseSmile);
app.post("/wallet/createVA", createVA);
app.post("/webhook/paystack", paystackWebhook);
app.get("/exams/jambServices", jambServices);
app.get('/transactions/status/:transactionId', transactionStatus);

// Social Feed routes
app.post('/social/posts', authMiddleware, socialController.createPost);
app.get('/social/feed', authMiddleware, socialController.getFeed);
app.post('/social/like', authMiddleware, socialController.likePost);
app.post('/social/comment', authMiddleware, socialController.commentOnPost);
app.get('/social/posts/:postId/comments', authMiddleware, socialController.getComments);
app.get('/social/leaderboard', authMiddleware, socialController.getTopEarners);
app.post('/social/upload', authMiddleware, upload.single('image'), uploadPostImage);

// Reward routes
app.post('/rewards/reward', authMiddleware, rewardController.rewardPost);
app.post('/rewards/convert', authMiddleware, rewardController.convertRewardPoints);
app.post('/rewards/boost', authMiddleware, rewardController.boostPost);
app.get('/rewards/stats', authMiddleware, rewardController.getCreatorStats);

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});