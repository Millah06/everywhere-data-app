// ─────────────────────────────────────────────────────────────────────────────
// Transaction Type Constants
// Use these everywhere you set Transaction.type in your backend.
// Consistent with the Flutter TransactionModel.displayLabel mapping.
// ─────────────────────────────────────────────────────────────────────────────

export const TX_TYPE = {

  // ── Utilities ──────────────────────────────────────────────────────────────
  AIRTIME:          "airtime",
  DATA:             "data",
  ELECTRICITY:      "electricity",
  CABLE:            "cable",

  // ── Education ─────────────────────────────────────────────────────────────
  WAEC_REG:         "waec_reg",
  WAEC_RESULT:      "waec_result",

  // ── Financial ─────────────────────────────────────────────────────────────
  TRANSFER_DEBIT:   "transfer_debit",    // money leaving user's wallet
  TRANSFER_CREDIT:  "transfer_credit",   // money entering user's wallet
  WALLET_FUNDING:   "wallet_funding",    // top-up from bank / card
  WALLET_WITHDRAWAL: "wallet_withdrawal",  // cash-out to bank / card

  // ── Marketplace ───────────────────────────────────────────────────────────
  ORDER_PAYMENT:    "order_payment",
  
  ORDER_REFUND:     "order_refund",

  // ── Gifts ─────────────────────────────────────────────────────────────────
  GIFT:             "gift",

} as const;

// Derive a union type so TypeScript enforces valid values everywhere
export type TxType = typeof TX_TYPE[keyof typeof TX_TYPE];

// ─────────────────────────────────────────────────────────────────────────────
// Usage example:
//
// import { TX_TYPE, TxType } from "./constants/transaction-types";
//
// await prisma.transaction.create({
//   data: {
//     userId: req.user.id,
//     type: TX_TYPE.AIRTIME,   // ← no typo possible
//     amount: 500,
//     ...
//   },
// });
//
// // Or type-safe function param:
// function buildReceipt(type: TxType) { ... }
// ─────────────────────────────────────────────────────────────────────────────