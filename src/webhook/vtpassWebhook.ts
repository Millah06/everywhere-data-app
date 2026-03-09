import crypto from "crypto";
import admin from "./utils/firebase";

const VTpassWebhook = async (req: any, res: any) => {
  // Verify the webhook signature
  const signature = req.headers["x-vtpass-signature"];
  const secret = process.env.VTPASS_SECRET || "";

  const hash = crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(req.body))
    .digest("hex");
  if (hash !== signature) {
    res.status(401).send("Invalid signature");
    return;
  }
  const { type, data } = req.body;

  if (type === "transaction-update") {
    const transactionRef = data.requestId;
    const transactionDoc = admin
      .firestore()
      .collection("transactions")
      .doc(transactionRef);

    if (!transactionDoc) {
      console.error("Transaction document not found for ref:", transactionRef);
      res.status(404).send("Transaction not found");
      return;
    }

    if (data.content.transactions.status == "delivered") {
      await transactionDoc.update({
        status: 'success',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(
        "Transaction status updated to:",
        data.content.transactions.status,
        "for ref:",
        transactionRef,
      );
    } else {
        await transactionDoc.update({
        status: data.content.transactions.status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log("Transaction successful for ref:", transactionRef);
    }
  }
  res.status(200).json({ response: "success" });
};

export default VTpassWebhook;
