import { Router } from "express";
import { authMiddleware, requireAdmin } from "../../../middleware/auth";
import usersController from "../controllers/users.controller";
import dashboardController from "../controllers/dashboard.controller";
import analyticsController from "../controllers/analytics.controller";
import transactionsController from "../controllers/transactions.controller";


const router = Router();

// ── ADMIN ─────────────────────────────────────────────────────────────────
router.get(
  "/admin/stats",
  authMiddleware,
  requireAdmin,
  dashboardController.getDashboardStats,
);

// Users
router.get(
  "/admin/users",
 authMiddleware,
  requireAdmin,
  usersController.getAllUsers,
);
router.get(
  "/admin/users/:userId",
  authMiddleware,
  requireAdmin,
  usersController.getUserDetail,
);
router.patch(
  "/admin/users/:userId/block",
  authMiddleware,
  requireAdmin,
  usersController.setUserActiveStatus,
);
router.patch(
  "/admin/users/:userId/role",
 authMiddleware,
  requireAdmin,
  usersController.updateUserRole,
);
router.patch(
  "/admin/users/:userId/kyc",
  authMiddleware,
  requireAdmin,
  usersController.updateKycStatus,
);

// Transactions
router.get(
  "/admin/transactions",
 authMiddleware,
  requireAdmin,
  transactionsController.getAllTransactions,
);
router.get(
  "/admin/transactions/search",
  authMiddleware,
  requireAdmin,
  transactionsController.searchTransactionByRef,
);
router.post(
  "/admin/transactions/:transactionId/refund",
 authMiddleware,
  requireAdmin,
  transactionsController.refundTransaction,
);
router.post(
  "/admin/transactions/manual-credit",
 authMiddleware,
  requireAdmin,
  transactionsController.manualCredit,
);
router.post(
  "/admin/transactions/manual-debit",
  authMiddleware,
  requireAdmin,
  transactionsController.manualDebit,
);

// Analytics
router.get(
  "/admin/top-users",
  authMiddleware,
  requireAdmin,
  analyticsController.getTopUsersByVolume,
);
router.get(
  "/admin/top-users/balance",
  authMiddleware,
  requireAdmin,
  analyticsController.getTopUsersByBalance,
);
router.get(
  "/admin/balances/summary",
  authMiddleware,
  requireAdmin,
  analyticsController.getBalanceSummary,
);

// ── MIGRATION (one-off, protect this in prod!) ────────────────────────────
router.post("/admin/migrate", async (req: any, res: any) => {
  try {
    const { migrationRunner } = await import("../../../migration");
    const result = await migrationRunner();
    return res.json(result);
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
});

export default router;
