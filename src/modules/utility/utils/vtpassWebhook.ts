import crypto from "crypto";
import { TransactionStatus } from "@prisma/client";
import { prisma } from "../../../prisma";

const VTpassWebhook = async (req: any, res: any) => {
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

    const row = await prisma.transaction.findFirst({
      where: {
        OR: [
          { transactionRef: transactionRef },
          { id: transactionRef },
          { clientRequestId: transactionRef },
        ],
      },
    });

    // Engine utility payments: requestId == Payment.id. Resolve those here too.
    if (!row) {
      const payment = await prisma.payment.findUnique({ where: { id: transactionRef } }).catch(() => null);
      if (payment) {
        const statusStr = data.content?.transactions?.status;
        const delivered = statusStr === "delivered";
        const pm = (payment.providerMeta as any) ?? {};
        if (delivered) {
          await prisma.payment.update({
            where: { id: payment.id },
            data: { providerMeta: { ...pm, delivery: { ...(pm.delivery ?? {}), status: "delivered" } } },
          });
        } else {
          // Refund to wallet (works for wallet- and OPay-paid utilities).
          const fiat = await prisma.fiat.findFirst({ where: { wallet: { userId: payment.userId } } });
          if (fiat) {
            await prisma.fiat.update({
              where: { id: fiat.id },
              data: { availableBalance: { increment: payment.amount } },
            });
          }
          await prisma.payment.update({
            where: { id: payment.id },
            data: { providerMeta: { ...pm, delivery: { ...(pm.delivery ?? {}), status: "refunded", reason: "vtpass_failed_async" } } },
          });
        }
        res.status(200).json({ response: "success" });
        return;
      }
    }

    if (!row) {
      console.error("Transaction not found for ref:", transactionRef);
      res.status(404).send("Transaction not found");
      return;
    }

    const statusStr = data.content?.transactions?.status;
    if (statusStr === "delivered") {
      await prisma.transaction.update({
        where: { id: row.id },
        data: { status: TransactionStatus.success },
      });
      console.log(
        "Transaction status updated to:",
        statusStr,
        "for ref:",
        transactionRef,
      );
    } else {
      await prisma.transaction.update({
        where: { id: row.id },
        data: { status: TransactionStatus.failed, message: String(statusStr) },
      });
      console.log("Transaction successful for ref:", transactionRef);
    }
  }
  res.status(200).json({ response: "success" });
};

export default VTpassWebhook;
