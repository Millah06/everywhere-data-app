import { Router } from "express";
import utilityRouter from "../modules/utility/routes/routes";
import socialRouter from "../modules/social/routes/routes";
import marketPlaceRouter from "../modules/marketPlace/marketPlace.routes";
import adminRouter from "../modules/admin/routes/routes";
import kycRouter from "../modules/kyc/routes/routes";
import userRouter from "../modules/user/routes/routes";
import authRouter from "../modules/auth/routes/routes";
import walletRouter from "../modules/wallet/routes/routes";
import supportChatRouter from "../modules/support/routes/routes";
import CommunicationRouter from "../modules/communication/routes/routes";
import searchRoutes from "../modules/search/routes/search.routes";
import { optionalAuthMiddleware} from "../middleware/auth";
import { getFollowers, getFollowing } from "../modules/search/controllers/search.controller";
import trustRoutes from "../modules/trust/trust.routes";
import paymentRoutes from "../modules/payment/payment.routes";
import "../modules/utility/utility.handler";      // ← registers the "utility" handler


const router = Router();

router.use(utilityRouter);
router.use(socialRouter);
router.use(marketPlaceRouter);
router.use(adminRouter);
router.use(kycRouter);
router.use(userRouter);
router.use(authRouter);
router.use(walletRouter);
router.use(supportChatRouter);
router.use(CommunicationRouter);
router.use('/search', searchRoutes);
router.get('/users/:userId/followers', optionalAuthMiddleware, getFollowers);
router.get('/users/:userId/following', optionalAuthMiddleware, getFollowing);
router.use(trustRoutes);
router.use(paymentRoutes);

export default router;
