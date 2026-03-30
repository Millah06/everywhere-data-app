import { Router } from "express";
import { authMiddleware } from "../../../middleware/auth";
import virtualAccountController from "../controllers/virtualAccount.controller";
import walletController from "../controllers/wallet.controller";
import externalWithdrawalController from "../controllers/externalWithdrawal.controller.";
const router = Router();

router.get("/banks/list", externalWithdrawalController.fetchListOfBanks);
router.get(
  "/banks/resolve/:accountNumber/:bankCode",
  externalWithdrawalController.resolveBankAccount,
);
router.post(
  "/banks/initiateWithdrawal",
  authMiddleware,
  externalWithdrawalController.createExternalWithdrawal,
);

// ── VIRTUAL ACCOUNTS ──────────────────────────────────────────────────────
router.get(
  "/virtual-accounts",
  authMiddleware,
  virtualAccountController.getMyVirtualAccounts,
);

router.post(
  "/virtual-accounts",
  authMiddleware,
  virtualAccountController.createVirtualAccount,
);
router.delete(
  "/virtual-accounts/:id",
  authMiddleware,
  virtualAccountController.deactivateVirtualAccount,
);

// ── WALLET ────────────────────────────────────────────────────────────────
router.get("/wallet", authMiddleware, walletController.getWallet);
router.get(
  "/wallet/transactions",
  authMiddleware,
  walletController.getWalletTransactions,
);
router.post(
  "/wallet/transfer",
  authMiddleware,
  walletController.internalTransfer,
);
// Paystack webhook — must be public, no auth, raw body parsing required
router.post("/wallet/webhook/paystack", walletController.paystackWebhook);

export default router;
