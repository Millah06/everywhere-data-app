import type { TransactionStatus, TransferStatus } from "@prisma/client";

/** Public API shape for transaction-related responses */
export type TransactionStatusApi = "PENDING" | "SUCCESS" | "FAILED";

export function prismaTransactionStatusToApi(
  status: TransactionStatus,
): TransactionStatusApi {
  if (status === "success") return "SUCCESS";
  if (status === "failed") return "FAILED";
  return "PENDING";
}

export function prismaTransferStatusToApi(
  status: TransferStatus,
): TransactionStatusApi {
  if (status === "success") return "SUCCESS";
  if (status === "failed") return "FAILED";
  return "PENDING";
}

/** `status: true` for SUCCESS and PENDING; `false` for FAILED */
export function apiStatusBoolean(ts: TransactionStatusApi): boolean {
  return ts !== "FAILED";
}

/**
 * Maps VTpass `content.transactions.status` (and similar) to API enum.
 * Unknown / async states → PENDING (do not treat as final failure).
 */
export function classifyVendorTransactionStatus(
  raw: string | undefined | null,
): TransactionStatusApi {
  if (raw == null || String(raw).trim() === "") return "PENDING";
  const s = String(raw).toLowerCase().trim();
  if (s === "delivered") return "SUCCESS";
  if (
    s === "failed" ||
    s === "failure" ||
    s === "error" ||
    s === "reversed"
  ) {
    return "FAILED";
  }
  if (
    s === "pending" ||
    s === "processing" ||
    s === "queued" ||
    s === "initiated" ||
    s === "in progress"
  ) {
    return "PENDING";
  }
  return "PENDING";
}

/** Paystack transfer `data.status` (e.g. pending, success, failed) */
export function paystackTransferDataStatusToApi(
  raw: string | undefined | null,
): TransactionStatusApi {
  if (raw == null || raw === "") return "PENDING";
  const s = String(raw).toLowerCase().trim();
  if (s === "success" || s === "completed" || s === "complete")
    return "SUCCESS";
  if (s === "failed" || s === "reversed" || s === "cancelled") return "FAILED";
  return "PENDING";
}

/** Extend a JSON body with `transactionStatus` and boolean `status` (unless `omitStatus` e.g. order object has its own `status`) */
export function withTransactionStatus<T extends Record<string, unknown>>(
  body: T,
  transactionStatus: TransactionStatusApi,
  options?: { message?: string; data?: unknown; omitStatus?: boolean },
): T & {
  transactionStatus: TransactionStatusApi;
  status?: boolean;
  message?: string;
  data?: unknown;
} {
  const out = {
    ...body,
    transactionStatus,
    ...(options?.omitStatus
      ? {}
      : { status: apiStatusBoolean(transactionStatus) }),
    ...(options?.message !== undefined ? { message: options.message } : {}),
    ...(options?.data !== undefined ? { data: options.data } : {}),
  };
  return out as T & {
    transactionStatus: TransactionStatusApi;
    status?: boolean;
    message?: string;
    data?: unknown;
  };
}
