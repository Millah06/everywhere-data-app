import { Request, Response } from "express";
import crypto from "crypto";
import { prisma } from "../../../prisma";
import { WalletService } from "../../../shared/services/wallet.service";
import { sendNotification } from "../../../shared/utils/notification";
import { TX_TYPE } from "../../../shared/utils/transactionType";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET!;

const paystackWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const signature = req.headers["x-paystack-signature"] as string;
    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== signature) {
      res.status(401).send("Invalid signature");
      return;
    }

    const { event, data } = req.body;

    const bonusCfg = await WalletService.getBonusConfig();

    if (event === "charge.success") {
      const fakeamount = data.amount / 100;
      const amount = fakeamount - bonusCfg.fundingFees;
      const email = data.customer.email;
      const senderName = data.authorization?.sender_name || "Unknown";
      const bankName = data.authorization?.sender_bank || "UnKnown";

      if (!email) {
        console.error("Missing email on charge.success");
        res.sendStatus(400);
        return;
      }

      const user = await prisma.user.findFirst({
        where: { email },
      });

      if (user) {
        const notificationToken = user.notificationToken;

        await WalletService.creditAvailableBalance({
          userId: user.id,
          amount,
        });

        await WalletService.createCreditTransaction({
          userId: user.id,
          amount,
          type: TX_TYPE.WALLET_FUNDING,
          metaData: {
            method: "Paystack VA",
            description: `Wallet funding via ${data.authorization?.bank}`,
          },
        });

        if (notificationToken) {
          await sendNotification(
            notificationToken,
            "Transfer Reeived",
            `You receeived ₦${amount} from ${senderName} via ${bankName}`,
          );
        }
      }
    }

    if (event === "transfer.success") {
      const transferRef = data.reference;

      const transferSnap = await prisma.transfer.findUnique({
        where: { id: transferRef },
      });

      if (!transferSnap?.senderId) {
        console.error(
          "Transfer document not found for reference:",
          transferRef,
        );
        res.sendStatus(404);
        return;
      }

      const uid = transferSnap.senderId;
      const user = await prisma.user.findUnique({
        where: { id: uid },
        select: { notificationToken: true },
      });
      const notificationToken = user?.notificationToken;

      await WalletService.finalizeExternalTransferSuccess({
        transferRef,
      });

      if (notificationToken) {
        await sendNotification(
          notificationToken,
          "Your Pending Transfer was successful",
          `You successfully sent ₦${transferSnap.amount} to ${data.recipient.name} via ${data.recipient.details.bank_name}`,
        );
      }
    }

    res.sendStatus(200);
  } catch (error: any) {
    console.error("Webhook error:", error.message);
    res.sendStatus(200);
  }
};

export default paystackWebhook;
