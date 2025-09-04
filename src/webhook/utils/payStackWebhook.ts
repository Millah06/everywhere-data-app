import { Request, Response } from "express";
import crypto from "crypto";
import admin from "../utils/firebase";
import { sendNotification } from "../notification";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET!;

const paystackWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    // ✅ Verify signature
    const signature = req.headers["x-paystack-signature"] as string;
    const hash = crypto.createHmac("sha512", PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== signature) {
      res.status(401).send("Invalid signature");
      return;
    }

    const { event, data } = req.body;

    const docRef = admin.firestore().collection('bonuses ').doc('reward');
    const doc = await docRef.get();
     const docData = doc.data();


    if (event === "charge.success") {
     
      const fakeamount = data.amount / 100;
      const amount = fakeamount -  docData?.fundingFees;
      const email = data.customer.email;
      const senderName = data.authorization?.sender_name || 'Unknown';
      const bankName = data.authorization?.sender_bank || 'UnKnown';
    //   const uid = data.metadata?.uid;

      if (!email ){
        console.error("Missing UID in metadata");
        res.sendStatus(400);
        return;
      }

      const userQuery = await admin.firestore().collection("users")
        .where("email", "==", email)
        .limit(1).get();

       if (!userQuery.empty) {
        const userDoc = userQuery.docs[0];
        const userRef = userDoc.ref;
        const currentWallet = userDoc.data()?.balance || 0;
        const notificationToken = userDoc.data().notificationToken;

        // ✅ Update wallet balance
        await userRef.update({
          balance: currentWallet + amount,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (notificationToken) {
          await sendNotification(
            notificationToken,
            'Transfer Reeived',
            `You receeived ₦${amount} from ${senderName} via ${bankName}`
          )
        }

        const newFund = userDoc.data().recentFund;

        await newFund.add({
          amount,
          type: "credit",
          method: "Paystack VA",
          description: `Wallet funding via ${data.authorization.bank}`,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        })

        // ✅ Add transaction
        await userRef.collection("transactions").add({
          amount,
          type: "credit",
          method: "Paystack VA",
          description: `Wallet funding via ${data.authorization.bank}`,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    res.sendStatus(200);
  } catch (error: any) {
    console.error("Webhook error:", error.message);
    res.sendStatus(200);
  }
};


export default paystackWebhook;