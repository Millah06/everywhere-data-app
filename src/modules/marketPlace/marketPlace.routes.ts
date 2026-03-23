import {Router} from "express";
import adminController from "../admin/controllers/marketPlace.controller";
import chatController from "../../chat/chatController";
import { authMiddleware } from "../../middleware/auth";
import branchController from "./branch/branchController";
import locationController from "./location/locationController";
import menuController from "./menu/menuController";
import orderController from "./order/orderController";
import uploadController from "./upload/uploadController";
import vendorController from "./vendor/vendorController";
import multer from "multer";


const  upload = multer({ storage: multer.memoryStorage(), 
  limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit
 
const router = Router();

// ── VENDOR ────────────────────────────────────────────────────────────────────
// NOTE: /vendor/me and /vendor/metrics MUST come before /vendor/:id
// because Express matches routes top-to-bottom and :id would swallow "me"
router.get("/vendor/list",  authMiddleware, vendorController.getVendors);
router.get("/vendor/me", authMiddleware, vendorController.getMyVendor);
router.get("/vendor/metrics", authMiddleware, vendorController.getVendorMetrics);
router.get("/vendor/:id", authMiddleware, vendorController.getVendorById);
router.post("/vendor/apply", authMiddleware, vendorController.applyAsVendor);
router.put("/vendor/visibility", authMiddleware, vendorController.toggleVisibility);
router.put("/vendor/pod-toggle", vendorController.togglePodAcceptance); // simple toggle like visibility
router.put("/vendor/profile", authMiddleware, vendorController.updateProfile);
router.post("/vendor/:id/review", authMiddleware, vendorController.addReview);
router.post("/vendor/upload/logo", upload.single("image"), uploadController.uploadVendorLogo);
router.post("/vendor/upload/coverPhoto", upload.single("image"), uploadController.uploadVendorCoverImage);
router.post("/vendor/upload/cac", upload.single("image"), uploadController.uploadCacCertificate);
router.post("/vendor/verify/request", vendorController.requestVerification);

// ── BRANCH ────────────────────────────────────────────────────────────────────
router.get("/branch/:branchId/menu", authMiddleware, branchController.getBranchMenu);
router.get("/branch/:branchId/delivery-zones", authMiddleware, branchController.getDeliveryZones);
router.post("/branch/add", authMiddleware, branchController.addBranch);
router.put("/branch/:branchId/update", authMiddleware, branchController.updateBranch);
router.delete("/branch/:branchId/delete", authMiddleware, branchController.deleteBranch);
router.post("/branch/:branchId/zone/add", authMiddleware, branchController.addDeliveryZone);
router.delete("/branch/zone/:zoneId/delete", authMiddleware, branchController.deleteDeliveryZone);

// ── MENU ──────────────────────────────────────────────────────────────────────
router.post("/menu/:branchId/add", menuController.addMenuItem);
router.get("/menu/manager/branches", authMiddleware, menuController.getManagerBranchesMenu);
router.put("/menu/:itemId/update", menuController.updateMenuItem);
router.delete("/menu/:itemId/delete", menuController.deleteMenuItem);
router.put("/menu/:itemId/toggle", menuController.toggleMenuItemAvailability);
router.post("/menu/:itemId/upload-image", upload.single("image"), uploadController.uploadMenuItemImage);

// ── ORDER ─────────────────────────────────────────────────────────────────────
// NOTE: /order/mine and /order/vendor/list MUST come before /order/:orderId
router.post("/order/place", orderController.placeOrder);
router.get("/order/mine", orderController.getMyOrders);

router.get("/order/vendor/list", orderController.getManagerOrders);

router.get("/order/:orderId", orderController.getOrderById);
router.post("/order/:orderId/confirm", orderController.confirmDelivery);
router.post("/order/:orderId/appeal", orderController.appealOrder);
router.post("/order/:orderId/cancel-appeal", orderController.cancelAppeal);
router.put("/order/:orderId/status", orderController.updateOrderStatus);
router.post("/order/:orderId/pod-confirm", orderController.confirmPodReceived);


router.get("/vendor/metrics/advanced", vendorController.getAdvancedMetrics);
router.put("/branch/:branchId/set-main", branchController.setMainBranch);
router.put("/branch/:branchId/assign-manager", branchController.assignManager);

// ── CHAT ──────────────────────────────────────────────────────────────────────
// Flutter listens to Firestore directly for realtime messages.
// Firestore path: orderChats/{orderId}/messages (ordered by createdAt asc)
// These HTTP endpoints handle sending and initial load only.
router.post("/chat/:orderId/send", chatController.sendMessage);
router.get("/chat/:orderId/messages", chatController.getMessages);

// ── LOCATION ──────────────────────────────────────────────────────────────────
// Used by Flutter dropdowns: state → lga → area → street (each call uses the id from previous)
router.get("/location/states", locationController.getStates);
router.get("/location/lgas/:stateId", locationController.getLgas);
router.get("/location/areas/:lgaId", locationController.getAreas);
router.get("/location/streets/:areaId", locationController.getStreets);
router.get("/location/hierarchy", locationController.getFullHierarchy);

// ── ADMIN ─────────────────────────────────────────────────────────────────────
// These routes are protected by auth middleware. Add role checks in each
// controller function when you have admin roles set up in your system.
router.get("/admin/vendor/pending", adminController.getPendingVendors);
router.post("/admin/vendor/:vendorId/approve", adminController.approveVendor);
router.post("/admin/vendor/:vendorId/reject", adminController.rejectVendor);
router.get("/admin/order/appeals", adminController.getAppeals);
router.post("/admin/order/:orderId/resolve", adminController.resolveAppeal);
router.post("/admin/chat/:orderId/send", chatController.adminSendMessage);
router.get("/admin/config", adminController.getConfig);
router.put("/admin/config", adminController.updateConfig);

export default router;