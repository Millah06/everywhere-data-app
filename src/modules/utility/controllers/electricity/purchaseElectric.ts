import axios from "axios";
import { calculateTransaction } from "../../helpers/calculateTransaction";
import { generateUUID } from "../../../../shared/utils/uuid";
import { WalletService } from "../../../../shared/services/wallet.service";
import { prisma } from "../../../../prisma";
import {
  classifyVendorTransactionStatus,
  prismaTransactionStatusToApi,
  withTransactionStatus,
  type TransactionStatusApi,
} from "../../../../shared/utils/transactionResponse";

const purchaseSecureElectric = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const {
      clientRequestId,
      network,
      phoneNumber,
      amount,
      humanRef,
      useReward,
      isRecharge,
      plan,
      serviceID,
      meterNumber,
      meterType,
      quantity,
    } = req.body;

    if (
      !phoneNumber ||
      !amount ||
      !network ||
      !clientRequestId ||
      !meterNumber ||
      !plan ||
      !serviceID ||
      !meterType
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const transferRef = generateUUID();

    const existing = await prisma.transaction.findUnique({
      where: { clientRequestId },
    });
    if (existing) {
      const transactionStatus = prismaTransactionStatusToApi(existing.status);
      return res.json(
        withTransactionStatus(
          { ...existing } as Record<string, unknown>,
          transactionStatus,
          { omitStatus: true },
        ),
      );
    }

    const bonus = await WalletService.getBonusConfig();

    const walletRow = await prisma.wallet.findUnique({
      where: { userId },
      include: { fiat: true },
    });
    if (!walletRow?.fiat) {
      return res.status(400).json({ error: "User not found" });
    }
    const wallet = walletRow.fiat;
    const rewardBalance = wallet.rewardBalance || 0;

    const bonusPercentFirst = bonus.cable;
    const calculation = calculateTransaction({
      productAmount: Number(amount),
      rewardBalance,
      walletBalance: wallet.availableBalance,
      useReward,
      isRecharge,
      bonusPercent: bonusPercentFirst,
    });

    const finalAmountToPay = calculation.walletToDeduct;

    const lock = await WalletService.lockUtilityFundsAndCreateTx({
      userId,
      clientRequestId,
      humanRef,
      vendorRequestId: transferRef,
      walletToDeduct: finalAmountToPay,
      rewardBalanceBefore: rewardBalance,
      finalRewardBalance: calculation.finalRewardBalance,
      useReward,
      isRecharge,
      bonusPercent: bonusPercentFirst,
      productAmount: Number(amount),
      metaData: {
        amout: finalAmountToPay,
        phoneNumber,
        productName: `${String(serviceID).toUpperCase()} Electricity Subscription`,
        bonusEarn: calculation.rewardToAdd,
        plan: plan,
        token: "",
        meterNumber,
        meterType,
      },
    });

    if (lock.idempotent) {
      const transactionStatus = prismaTransactionStatusToApi(
        lock.transaction.status,
      );
      return res.json(
        withTransactionStatus(
          { ...lock.transaction } as Record<string, unknown>,
          transactionStatus,
          { omitStatus: true },
        ),
      );
    }

    let vendorResponse: any;
    try {
      const response = await axios.post(
        "https://vtpass.com/api/pay",
        {
          request_id: transferRef,
          serviceID: serviceID,
          billersCode: meterNumber !== undefined ? meterNumber : undefined,
          amount: amount,
          phone: phoneNumber,
          variation_code: meterType,
          ...(quantity && { quantity }),
        },
        {
          headers: {
            "api-key": process.env.VTPASS_API_KEY,
            "secret-key": process.env.VTPASS_SECRET_KEY,
          },
          timeout: 15000,
        },
      );
      vendorResponse = response.data;
    } catch (err: any) {
      vendorResponse = { error: err.message };
    }

    const rawStatus = vendorResponse.content?.transactions?.status;
    let outcome: TransactionStatusApi;
    if (vendorResponse.error) {
      outcome = "FAILED";
    } else {
      outcome = classifyVendorTransactionStatus(rawStatus);
    }

    if (outcome === "PENDING") {
      return res.json(
        withTransactionStatus(
          {
            transaction_id: humanRef,
            date: new Date().toISOString(),
          },
          "PENDING",
        ),
      );
    }

    const txRow = await prisma.transaction.findUnique({
      where: { clientRequestId },
    });
    const meta = (txRow?.metaData as Record<string, number | boolean>) ?? {};
    const rewardBalBefore =
      typeof meta.rewardBalanceBefore === "number"
        ? meta.rewardBalanceBefore
        : 0;

    const walletAfter = await prisma.wallet.findUnique({
      where: { userId },
      include: { fiat: true },
    });
    const avail = walletAfter?.fiat?.availableBalance ?? 0;

    const bonusPercentSecond = bonus.electric;
    const recalc = calculateTransaction({
      productAmount: Number(amount),
      rewardBalance: rewardBalBefore,
      walletBalance: avail,
      useReward,
      isRecharge,
      bonusPercent: bonusPercentSecond,
    });

    if (outcome === "SUCCESS") {
      await WalletService.finalizeUtilityTransaction({
        userId,
        clientRequestId,
        delivered: true,
        vendorResponse,
        successRewardBalanceOverride: recalc.finalRewardBalance,
        patchMeta: (m) => {
          m.token = vendorResponse?.Token as string;
        },
      });

      return res.json(
        withTransactionStatus(
          {
            transaction_id: humanRef,
            date: new Date().toISOString(),
            token: vendorResponse?.Token,
          },
          "SUCCESS",
        ),
      );
    }

    await WalletService.finalizeUtilityTransaction({
      userId,
      clientRequestId,
      delivered: false,
      vendorResponse,
    });

    return res.json(withTransactionStatus({}, "FAILED"));
  } catch (error: any) {
    console.error(
      "sendDataSecure error:",
      error.message,
      "RequestID:",
      req.body.requestID,
      "UserID:",
      req.body.uid,
    );

    try {
      const userId = req.user?.id;
      if (req.body.clientRequestId && userId) {
        await WalletService.refundPendingUtilityTx({
          userId,
          clientRequestId: req.body.clientRequestId,
        });
      }
    } catch (unlockError) {
      console.error("Error unlocking funds after failure:", unlockError);
    }

    return res.status(500).json(
      withTransactionStatus(
        {
          error: "Data failed",
          details: error.message,
        },
        "FAILED",
        { message: error.message },
      ),
    );
  }
};

export default purchaseSecureElectric;
