import axios from "axios";
import { checkAuth } from "../webhook/utils/auth";
import * as admin from "firebase-admin";
import { calculateTransaction } from "../utils/calculateTransaction";

const sendAirtimeSecure = async (req: any, res: any) => {
  try {
    const {
      clientRequestId,
      network,
      phoneNumber,
      amount,
      humanRef,
      requestID,
      useReward,
      isRecharge,
    } = req.body;

    if (!phoneNumber || !amount || !network || !requestID || !clientRequestId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const uid = await checkAuth(req); // Verify auth

    let responsePayload;

    const transactionDocRef = admin
      .firestore()
      .collection("transactions")
      .doc(clientRequestId);

    // Check for idempotency
    const existing = await transactionDocRef.get();
    if (existing.exists) {
      return res.json(existing.data());
    }

    const userRef = admin.firestore().collection("users").doc(uid);
    const bonusDoc = await admin.firestore().collection("bonuses ").doc("reward").get();

    // Begin Firestore transaction
    await admin.firestore().runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("User not found");

      const wallet = userDoc.data()?.wallet?.fiat;
      const rewardBalance = wallet?.rewardBalance || 0;
      const bonusPercent = bonusDoc.data()?.airtime;

      // Calculate how much to deduct from wallet
      const calculation = calculateTransaction({
        productAmount: Number(amount),
        rewardBalance,
        walletBalance: wallet.availableBalance,
        useReward,
        isRecharge,
        bonusPercent,
      });

      const finalAmountToPay = calculation.walletToDeduct;

      if (wallet.availableBalance < finalAmountToPay) {
        throw new Error("Insufficient balance");
      }

      // Lock the funds and create transaction doc
      t.update(userRef, {
        "wallet.fiat.availableBalance": wallet.availableBalance - finalAmountToPay,
        "wallet.fiat.lockedBalance": wallet.lockedBalance + finalAmountToPay,
      });

      t.set(transactionDocRef, {
        userId: uid,
        type: "utility",
        clientRequestId,
        metaData: {
          finalAmountToPay,
          phoneNumber,
          productName: `${network.toUpperCase()} Airtime`,
        },
        humanRef,
        status: "processing",
        finalAmount: finalAmountToPay,
        rewardBalanceBefore: rewardBalance,
        finalRewardBalance: calculation.finalRewardBalance,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

     // Call third-party vendor
    let vendorResponse;
    try {

      const response = await axios.post(
      "https://vtpass.com/api/pay",
      {
        request_id: requestID,
        serviceID: network,
        amount,
        phone: phoneNumber,
      },
      {
        headers: {
          "api-key": process.env.VTPASS_API_KEY,
          "secret-key": process.env.VTPASS_SECRET_KEY,
        },
        timeout: 15000, // 15 seconds timeout
      }
    );

    vendorResponse = response.data;

    } catch (err: any) {
       vendorResponse = { error: err.message, };
    }
   

    const transactionStatus = vendorResponse.content?.transactions?.status;

    console.log("Vendor response:", vendorResponse);

    

    // Final Firestore transaction to update locked balance and status
    await admin.firestore().runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const wallet = userDoc.data()?.wallet?.fiat;
      const rewardBalance = wallet?.rewardBalance || 0;

      // Retrieve calculation stored before
      const transactionData = (await t.get(transactionDocRef)).data();
      const lockedAmount = transactionData?.finalAmount || 0;

      if (transactionStatus === "delivered") {
        // Deduct locked funds, add rewards
        t.update(userRef, {
          "wallet.fiat.lockedBalance": wallet.lockedBalance - lockedAmount,
          "wallet.fiat.rewardBalance": transactionData?.finalRewardBalance,
        });

        t.update(transactionDocRef, {
          status: "success",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          vendorResponse,
        });

        responsePayload = { status: true, transaction_id: humanRef, date: admin.firestore.FieldValue.serverTimestamp() };
      } else {
        // Refund locked funds, no reward
        t.update(userRef, {
          "wallet.fiat.lockedBalance": wallet.lockedBalance - lockedAmount,
          "wallet.fiat.availableBalance": wallet.availableBalance + lockedAmount,
          "wallet.fiat.rewardBalance": rewardBalance,
        });

        t.update(transactionDocRef, {
          status: "failed",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          vendorResponse,
        });

        responsePayload = { status: false };
      }
    });

    return res.json(responsePayload);

  } catch (error: any) {
    console.error(
      "sendAirtimeSecure error:",
      error.message,
      "RequestID:",
      req.body.requestID,
      "UserID:",
      req.body.uid
    );

    // Optional: unlock funds if any transaction exists but got stuck
    try {
      const uid = await checkAuth(req)
      if (req.body.clientRequestId) {
        const txRef = admin.firestore().collection("transactions").doc(req.body.clientRequestId);
        const txDoc = await txRef.get();
        if (txDoc.exists && txDoc.data()?.status === "processing") {
          const userRef = admin.firestore().collection("users").doc(uid);
          await admin.firestore().runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            const wallet = userDoc.data()?.wallet?.fiat;
            const lockedAmount = txDoc.data()?.finalAmount || 0;
            t.update(userRef, {
              "wallet.fiat.lockedBalance": wallet.lockedBalance - lockedAmount,
              "wallet.fiat.availableBalance": wallet.availableBalance + lockedAmount,
            });
            t.update(txRef, {
              status: "failed",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              error: "I failed here",
            });
          });
        }
      }
    } catch (unlockError) {
      console.error("Error unlocking funds after failure:", unlockError);
    }

    return res.status(500).json({
      error: "Airtime failed",
      details: error.message,
    });
  }
};

export default sendAirtimeSecure;