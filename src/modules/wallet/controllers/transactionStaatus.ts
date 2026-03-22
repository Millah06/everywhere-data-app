import { TransactionStatus } from "@prisma/client";
import { prisma } from "../../../prisma";
import { prismaTransactionStatusToApi } from "../../../shared/utils/transactionResponse";

const transactionStatus = async (req: any, res: any) => {
  const { transactionId } = req.params;
  try {
    const row = await prisma.transaction.findFirst({
      where: { humanRef: transactionId },
    });

    if (!row) {
      return res.status(404).json({
        status: false,
        transactionStatus: "FAILED" as const,
        transaction_id: transactionId,
        message: "Transaction not found",
        date: new Date().toISOString(),
      });
    }

    const meta = (row.metaData as Record<string, unknown>) ?? {};
    const processing = row.status === TransactionStatus.pending;
    const transactionStatusApi = prismaTransactionStatusToApi(row.status);

    const legacyStatus =
      row.status === TransactionStatus.success
        ? true
        : row.status === TransactionStatus.failed
          ? false
          : null;

    return res.json({
      ...meta,
      status: legacyStatus,
      transaction_id: row.humanRef ?? transactionId,
      date: row.updatedAt ?? row.createdAt,
      ...(processing ? { message: "Transaction still processing" } : {}),
      finalAmount:
        (meta.finalAmount as number) ??
        (meta.amount as number) ??
        row.amount,
      transactionStatus: transactionStatusApi,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: false,
      transactionStatus: "FAILED" as const,
      transaction_id: transactionId,
      message: "Error fetching transaction",
      date: new Date().toISOString(),
    });
  }
};

export default transactionStatus;
