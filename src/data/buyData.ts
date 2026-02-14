import axios from "axios";
import {checkAuth} from "../webhook/utils/auth";

import * as admin from "firebase-admin";
import { calculateTransaction } from "../utils/calculateTransaction";

const buyDataSecure = async (req: any, res: any) => {
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
      variationCode,
      plan,
    } = req.body;

    if (!phoneNumber || !amount || !network || !requestID || !clientRequestId || !variationCode || !plan) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const uid = await checkAuth(req); // Verify auth

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
      const bonusPercent = bonusDoc.data()?.data;

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
          amout: finalAmountToPay,
          phoneNumber,
          subType: `${network.toUpperCase()} Data`,
          bonusEarn: calculation.rewardToAdd,
          plan: plan,
        },
        humanRef,
        status: "processing",
        amout: finalAmountToPay,
        rewardBalanceBefore: rewardBalance,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Call third-party vendor
    const vendorResponse = await axios.post("https://vtpass.com/api/pay", {
      request_id: requestID,
      serviceID: network,
      variation_code: variationCode,
      phone: phoneNumber,
    }, {
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "secret-key": process.env.VTPASS_SECRET_KEY,
      },
       timeout: 15000, // 15 seconds timeout
    });
    

    const transactionStatus = vendorResponse.data?.content?.transactions?.status;

    // Final Firestore transaction to update locked balance and status
    await admin.firestore().runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const wallet = userDoc.data()?.wallet?.fiat;
      const rewardBalance = wallet?.rewardBalance || 0;

      // Retrieve calculation stored before
      const transactionData = (await t.get(transactionDocRef)).data();
      const lockedAmount = transactionData?.walletToDeduct || 0;

      const calculation = calculateTransaction({
        productAmount: Number(amount),
        rewardBalance: transactionData?.rewardBalanceBefore || 0,
        walletBalance: wallet.availableBalance,
        useReward,
        isRecharge,
        bonusPercent: bonusDoc.data()?.data,
      });

      if (transactionStatus === "delivered") {
        // Deduct locked funds, add rewards
        t.update(userRef, {
          "wallet.fiat.lockedBalance": wallet.lockedBalance - lockedAmount,
          "wallet.fiat.rewardBalance": calculation.finalRewardBalance,
        });

        t.update(transactionDocRef, {
          status: "success",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          
          vendorResponse,
        });

        return res.json({ status: true, transaction_id: humanRef, date: admin.firestore.FieldValue.serverTimestamp() });
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

        return res.json({ status: false });
      }
    });
  } catch (error: any) {
    console.error(
      "sendDataSecure error:",
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
            const lockedAmount = txDoc.data()?.walletToDeduct || 0;
            t.update(userRef, {
              "wallet.fiat.lockedBalance": wallet.lockedBalance - lockedAmount,
              "wallet.fiat.availableBalance": wallet.availableBalance + lockedAmount,
            });
            t.update(txRef, {
              status: "failed",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          });
        }
      }
    } catch (unlockError) {
      console.error("Error unlocking funds after failure:", unlockError);
    }

    return res.status(500).json({
      error: "Data failed",
      details: error.message,
    });
  }
};

export default buyDataSecure;