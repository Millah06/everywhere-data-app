import { Router } from "express";
import { authMiddleware, requireAdmin } from "../../../middleware/auth";
import usersController from "../controllers/users.controller";
import dashboardController from "../controllers/dashboard.controller";
import analyticsController from "../controllers/analytics.controller";
import transactionsController from "../controllers/transactions.controller";
import marketPlaceController from "../controllers/marketPlace.controller";


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

router.post('/admin/migrate', usersController.migrateUsers);

//marketPlace
// ── ADMIN ─────────────────────────────────────────────────────────────────────
// These routes are protected by auth middleware. Add role checks in each
// controller function when you have admin roles set up in your system.
router.get("/admin/vendors", authMiddleware,
  requireAdmin, marketPlaceController.getVendors);

router.post("/admin/vendor/:vendorId/approve", authMiddleware,
  requireAdmin, marketPlaceController.approveVendor);
router.post("/admin/vendor/:vendorId/reject", authMiddleware,
  requireAdmin, marketPlaceController.rejectVendor);

router.get("/admin/order/appeals", authMiddleware,
  requireAdmin, marketPlaceController.getAppeals);
router.post("/admin/order/:orderId/resolve", authMiddleware,
  requireAdmin, marketPlaceController.resolveAppeal);
router.post("/admin/chat/:orderId/send", authMiddleware,
  requireAdmin, marketPlaceController.adminSendMessage);

router.get("/admin/config", authMiddleware,
  requireAdmin, marketPlaceController.getConfig);
router.patch("/admin/config", authMiddleware,
  requireAdmin, marketPlaceController.updateConfig);


export default router;
