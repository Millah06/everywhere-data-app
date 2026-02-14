import admin from "../webhook/utils/firebase";

const transactionStatus =   async (req: any, res: any) => {
  const { transactionId } = req.params;
  try {
    const txSnap = await admin.firestore()
      .collection("transactions")
      .where("humanRef", "==", transactionId)
      .limit(1)
      .get();

    if (txSnap.empty) {
      return res.status(404).json({
        status: 'failed',
        transaction_id: transactionId,
        message: 'Transaction not found',
        date: new Date().toISOString()
      });
    }

    const tx = txSnap.docs[0].data();
    return res.json({
      status: tx.status === "success" ? true : tx.status === "failed" ? false : null,
      transaction_id: tx.humanRef,
      date: tx.updatedAt || tx.createdAt,
      message: tx.status === "processing" ? "Transaction still processing" : undefined,
      ...tx.metaData,
      finalAmount: tx.finalAmount || tx.metaData.amount
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: false,
      transaction_id: transactionId,
      message: 'Error fetching transaction',
      date: new Date().toISOString()
    });
  }
};

export default transactionStatus;