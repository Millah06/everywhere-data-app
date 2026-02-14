import admin from "../webhook/utils/firebase";


const createWalletTransfer = async (req: any, res: any) => {

    try {
        const {amount, clientRequestId, humanRef, senderUid, receiverUid} = req.body;

        if (!receiverUid || !amount) {
            return res.status(400).json({ error: "Missing receiverUid or amount" });
        }
        const usersRef = admin.firestore().collection('users');
        const transfersRef = admin.firestore().collection('transfers');
        const transactionsRef = admin.firestore().collection('transactions');

        const sendertransactionDoc = transactionsRef.doc();
        const receivertransactionDoc = transactionsRef.doc();


        // Idempotency check
        const existing = await transfersRef
            .where('clientRequestId', '==', req.body.clientRequestId)
            .limit(1)
            .get();

        if (!existing.empty) {
        return res.json(existing.docs[0].data());
        }               
        const transferDoc = transfersRef.doc(clientRequestId);

        await admin.firestore().runTransaction(async (transaction) =>  {

            const senderDoc = usersRef.doc(senderUid);
            const receiverDoc = usersRef.doc(receiverUid);

            const senderSnap = await transaction.get(senderDoc);
            const receiverSnap = await transaction.get(receiverDoc);      

            const senderBalance = senderSnap.data()?.wallet.fiat.availableBalance;
            

        if (senderBalance < amount) {
            throw new Error("Insufficient balance");
        }

        const newSenderBalance = senderBalance - amount;
        const receiverBalance = (receiverSnap.data()?.wallet.fiat.availableBalance as number);

        const newReceiverBalance = receiverBalance + amount;
      // Update balances
        transaction.update(senderDoc, {
            'wallet.fiat.availableBalance': newSenderBalance,
        });

        transaction.update(receiverDoc, {
            'wallet.fiat.availableBalance': newReceiverBalance,
        });

        // Create transfer doc
        transaction.set(transferDoc, {
            humanRef: humanRef,
            clientRequestId: clientRequestId,
            mode: 'wallet',  
            senderUid: senderUid,
            receiverUid: receiverUid,
            amount  : amount,
            status: 'processing',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Sender transaction
        transaction.set(transactionsRef.doc(), {
            userId: senderUid,
            transferId : transferDoc.id,
            type: "utility",       
            clientRequestId,     
            direction: 'debit',
            amount: amount,
            balanceBefore: senderBalance,
            balanceAfter: newSenderBalance,
            humanRef: humanRef,
            status: 'processing',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Receiver transaction
        transaction.set(transactionsRef.doc(), {
            uid: receiverUid,
            humanRef: humanRef,
            transferId: transferDoc.id,
            direction: 'credit',
            amount: amount,
            balanceBefore: receiverBalance,
            balanceAfter: newReceiverBalance,
            status: 'processing',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    });

    // 2️⃣ Update transfer to success AFTER transaction
        await transferDoc.update({
            'status': 'success',
            'updatedAt': admin.firestore.FieldValue.serverTimestamp(),
        });

         await sendertransactionDoc.update({
                'status': 'success',
                'updatedAt': admin.firestore.FieldValue.serverTimestamp(),
              });
              
         await receivertransactionDoc.update({
                'status': 'success',
                'updatedAt': admin.firestore.FieldValue.serverTimestamp(),
              });
        return res.status(200).json({ status: "success", transferId: transferDoc.id });
    // // 3️⃣ Send notification
    // await _sendTransferNotification(receiverUid, amount, humanRef);
    }
    catch (error: any) {        
        console.error("createWalletTransfer error:", error.message);
        return res.status(500).json({ error: "Transfer failed", details: error.message });
    }
}

export default createWalletTransfer;

 