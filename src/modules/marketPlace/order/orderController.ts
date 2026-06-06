import { prisma } from "../../../prisma";
import admin from "firebase-admin";
import { sendNotification } from "../../../shared/utils/notification";
import { generateUUID } from "../../../shared/utils/uuid";
import { Order } from "@prisma/client";
import { WalletService } from "../../../shared/services/wallet.service";
import {
  prismaTransactionStatusToApi,
  withTransactionStatus,
} from "../../../shared/utils/transactionResponse";
import { FieldValue } from "firebase-admin/firestore";
import { TX_TYPE } from "../../../shared/utils/transactionType";
import {
  getVendorSettlementDelayHours,
  getVendorTrustLevel,
  canSellAtLevel,
} from "../settlement/settlement.rules";

import {
  releaseHold,
  freezeHold,
  unfreezeHold,
  refundHold,
  settlementTablesReady,
} from "../settlement/settlement.service";

/**
 * Phase 6: true when this order uses the new settlement-hold model. Legacy
 * in-flight orders (no hold, has an Escrow row) return false and keep the old
 * money paths below — a clean, drain-on-its-own cutover.
 */
async function hasSettlementHold(orderId: string): Promise<boolean> {
  if (!(await settlementTablesReady())) return false;
  const hold = await prisma.settlementHold.findUnique({ where: { orderId } });
  return !!hold;
}

const notify = async (token: string, title: string, body: string) => {
  await sendNotification(token, title, body);
};

const recalculateVendorMetrics = async (vendorId: string) => {
  const all = await prisma.order.findMany({ where: { vendorId } });
  const completed = all.filter((o: any) => o.status === "completed");
  const rate =
    all.length > 0 ? Math.round((completed.length / all.length) * 100) : 100;
  await prisma.vendor.update({
    where: { id: vendorId },
    data: { totalCompletedOrders: completed.length, completionRate: rate },
  });
};

const placeOrder = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const user = await prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        notificationToken: true,
        name: true,
      },
    });

    const clientRequestId = "";

    const notificationToken = user?.notificationToken;

    const { vendorId, branchId, items, deliveryAddress, paymentMethod } =
      req.body;

    const config = await prisma.appConfig.findFirst();
    if (!config)
      return res
        .status(500)
        .json({ message: "App config not found. Ask admin to seed it." });

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      include: { vendor: true, deliveryZones: true },
    });

    if (!branch) return res.status(404).json({ message: "Branch not found" });
    if (branch.vendorId !== vendorId)
      return res
        .status(400)
        .json({ message: "Branch does not belong to this vendor" });

    // Trust gate (spec §11): level-0 vendors cannot sell. Fail-open — any
    // lookup error or missing profile defaults to ALLOW so ordering never
    // breaks (e.g. before the gated migration, or for un-seeded vendors).
    const sellerLevel = await getVendorTrustLevel(vendorId);
    if (!canSellAtLevel(sellerLevel)) {
      return res.status(403).json({
        message: "This store is not yet verified to accept orders.",
      });
    }

    const zone = branch.deliveryZones.find(
      (z: any) => z.area === deliveryAddress.area,
    );
    if (!zone)
      return res.status(400).json({
        message: `No delivery zone set up for area: ${deliveryAddress.area}`,
      });

    let subtotal = 0;
    const enrichedItems: {
      menuItemId: string;
      name: string;
      price: number;
      quantity: number;
    }[] = [];

    for (const reqItem of items as { menuItemId: string; quantity: number }[]) {
      const menuItem = await prisma.menuItem.findUnique({
        where: { id: reqItem.menuItemId },
      });
      if (!menuItem)
        return res
          .status(404)
          .json({ message: `Menu item not found: ${reqItem.menuItemId}` });
      if (menuItem.branchId !== branchId)
        return res
          .status(400)
          .json({ message: `${menuItem.name} does not belong to this branch` });
      if (!menuItem.isAvailable)
        return res
          .status(400)
          .json({ message: `${menuItem.name} is currently unavailable` });

      enrichedItems.push({
        menuItemId: menuItem.id,
        name: menuItem.name,
        price: menuItem.price, // snapshot — future price edits will NOT affect this order
        quantity: reqItem.quantity,
      });
      subtotal += menuItem.price * reqItem.quantity;
    }

    const deliveryFee = zone.deliveryFee;
    const transactionFee = subtotal * (config.transactionFeePercent / 100);
    const totalAmount = subtotal + deliveryFee + transactionFee;

    // After validating items, before creating order:
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });

    if (paymentMethod === "pay_on_delivery" && !vendor!.allowsPayOnDelivery) {
      return res
        .status(400)
        .json({ message: "This vendor does not accept pay on delivery" });
    }

    const isPod = paymentMethod === "pay_on_delivery";
    let order;

    if (isPod) {
      // ── POD (pay on delivery) — LEGACY cash flow, intentionally UNCHANGED ───
      // Locks at placement exactly as before; no escrow, no settlement hold.
      const transactionRef = generateUUID();
      const lockClientId = clientRequestId || transactionRef;

      const lock = await WalletService.lockFundsForOrder({
        userId,
        amount: totalAmount,
        clientRequestId: lockClientId,
        metaData: {
          finalAmountToPay: totalAmount,
          productName: "Product Purchase",
          direction: "debit",
          transactionID: "",
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

      order = await prisma.order.create({
        data: {
          userId,
          userName: user?.name?.split(" ")[0] || "User",
          vendorId,
          branchId,
          subtotal,
          deliveryFee,
          transactionFee,
          totalAmount,
          status: "pending",
          escrowStatus: "noEscrow",
          paymentMethod: "pay_on_delivery",
          deliveryState: deliveryAddress.state,
          deliveryLga: deliveryAddress.lga,
          deliveryArea: deliveryAddress.area,
          deliveryStreet: deliveryAddress.street,
          vendorName: branch.vendor.name,
          vendorLogo: branch.vendor.logo,
          branchName: `${branch.area}, ${branch.lga}`,
          items: { create: enrichedItems },
        },
        include: { items: true },
      });

      await prisma.transaction.update({
        where: { id: lock.transaction.id },
        data: { orderId: order.id },
      });
    } else {
      // ── PREPAID (wallet or OPay) — Phase 6 ─────────────────────────────────
      // Create the order UNPAID (no wallet lock, no escrow). The Flutter
      // PaymentSheet pays up front (wallet or OPay); on payment SUCCESS the
      // `marketplace_order` handler confirms the order and creates the merchant
      // settlement hold (NET of our cut). If the buyer abandons payment, the
      // order stays pending and auto-cancels in 30 min (no money was moved).
      order = await prisma.order.create({
        data: {
          userId,
          userName: user?.name?.split(" ")[0] || "User",
          vendorId,
          branchId,
          subtotal,
          deliveryFee,
          transactionFee,
          totalAmount,
          status: "pending",
          escrowStatus: "held",
          paymentMethod,
          deliveryState: deliveryAddress.state,
          deliveryLga: deliveryAddress.lga,
          deliveryArea: deliveryAddress.area,
          deliveryStreet: deliveryAddress.street,
          vendorName: branch.vendor.name,
          vendorLogo: branch.vendor.logo,
          branchName: `${branch.area}, ${branch.lga}`,
          items: { create: enrichedItems },
        },
        include: { items: true },
      });
    }

    const chatRef = admin.firestore().collection("orderChats").doc(order.id);

    try {
      await chatRef.set(
        {
          participants: FieldValue.arrayUnion(userId, vendorId),
          isAppealed: false,
          isClosed: false,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (err) {
      console.error("Chat creation failed:", err);
    }

    if (notificationToken) {
      await sendNotification(
        notificationToken,
        "New Order Created",
        `You have a new order worth ₦${totalAmount}`,
      );
    }

    res
      .status(201)
      .json(
        withTransactionStatus(
          { ...order } as Record<string, unknown>,
          "PENDING",
          { omitStatus: true },
        ),
      );
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getMyOrders = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { status } = req.query;

    const orders = await prisma.order.findMany({
      where: { userId, ...(status && { status: status as any }) },
      include: { items: true },
      orderBy: { createdAt: "desc" },
    });

    res.json(orders);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getOrderById = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, escrow: true },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.userId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    res.json(order);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const confirmDelivery = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.userId !== userId)
      return res.status(403).json({ message: "Unauthorized" });
    if (order.status !== "delivered")
      return res
        .status(400)
        .json({ message: "Order is not in delivered state" });

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { status: "completed", escrowStatus: "released" },
      include: { items: true },
    });

    const vendor = await prisma.vendor.findUnique({
      where: { id: order.vendorId },
      include: { user: true },
    });

    if (await hasSettlementHold(orderId)) {
      // Phase 6: settle the merchant's pending hold → wallet available (NET).
      await releaseHold(orderId);
      await recalculateVendorMetrics(order.vendorId);
    } else {
      // Legacy escrow order — unchanged behaviour.
      await prisma.escrow.update({
        where: { orderId },
        data: { releaseStatus: "released", releasedAt: new Date() },
      });

      await recalculateVendorMetrics(order.vendorId);

      await WalletService.creditAvailableBalance({
        userId: vendor!.ownerId,
        amount: order.totalAmount,
      });
      await WalletService.createCreditTransaction({
        userId: vendor!.ownerId,
        amount: order.totalAmount,
        type: TX_TYPE.ORDER_PAYMENT,
        metaData: { orderId, vendorId: vendor!.id },
      });

      await WalletService.releaseEscow({
        userId: userId,
        amount: order.totalAmount,
        orderId: order.id,
      });
    }

    if (vendor)
      await notify(
        vendor.user.notificationToken!,
        "ORDER COMPLETED",
        "Your order has been completed and payment released to your wallet.",
      );
    const user = await prisma.user.findUnique({
      where: { id: order.userId },
      select: { notificationToken: true },
    });
    if (user) {
      await notify(
        user.notificationToken!,
        "ORDER COMPLETED",
        "Your order has been completed and payment has been released to the counterparty.",
      );
    }

    res.json(updated);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const appealOrder = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { branch: true },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.userId !== userId && order.branch.managerId !== userId)
      return res.status(403).json({ message: "Unauthorized" });

    // With this:
    const appealableStatuses = [
      "delivered",
      "confirmed",
      "preparing",
      "outForDelivery",
    ];
    if (!appealableStatuses.includes(order.status)) {
      return res.status(400).json({ message: "Cannot appeal this order" });
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "appealed",
        escrowStatus: "appealed",
        appealedBy: userId,
      },
      include: { items: true },
    });

    if (await hasSettlementHold(orderId)) {
      // Phase 6: freeze the pending hold — payout blocked until resolved.
      await freezeHold(orderId, reason ?? "appeal");
    } else {
      await prisma.escrow.update({
        where: { orderId },
        data: {
          releaseStatus: "appealed",
          appealReason: reason,
          autoReleaseAt: new Date("2099-01-01"), // freeze — admin must resolve
        },
      });
    }

    const customerSupport = await prisma.user.findFirst({
      where: { role: "admin" },
    });

    const chatRef = admin.firestore().collection("orderChats").doc(order.id);

    await chatRef.set(
      {
        participants: FieldValue.arrayUnion(customerSupport?.firebaseUid),
        isAppeald: true,
      },
      { merge: true },
    );

    await admin.firestore().collection("adminNotifications").add({
      type: "ORDER_APPEALED",
      orderId,
      reason,
      userId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json(updated);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const getManagerOrders = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { status } = req.query;

    const branches = await prisma.branch.findMany({
      where: { managerId: userId },
    });

    if (!branches) return res.status(404).json({ message: "Branch not found" });

    const orders = await prisma.order.findMany({
      where: {
        branch: {
          managerId: userId,
        },
        ...(status && { status: status as any }),
      },
      include: { items: true },
      orderBy: { createdAt: "desc" },
    });

    res.json(orders);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const updateOrderStatus = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;
    const { status } = req.body;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const branch = await prisma.branch.findFirst({
      where: { managerId: userId },
    });

    if (!branch) return res.status(403).json({ message: "Unauthorized" });

    const allowed: Record<string, string[]> = {
      pending: ["confirmed", "cancelled"],
      confirmed: ["preparing"],
      preparing: ["outForDelivery"],
      outForDelivery: ["delivered"],
    };

    if (!allowed[order.status]?.includes(status)) {
      return res.status(400).json({
        message: `Cannot change status from ${order.status} to ${status}`,
      });
    }

    let updated: Order;

    if (status === "cancelled") {
      updated = await prisma.order.update({
        where: { id: orderId },
        data: { escrowStatus: "refunded", updatedAt: new Date(), status },
        include: { items: true },
      });

      // After: updated = await prisma.order.update({ where: { id: orderId }, data: { status }, ... });
      const db = admin.firestore();
      const now = admin.firestore.FieldValue.serverTimestamp();
      await db
        .doc(`orderPings/${order.userId}`)
        .set({ updatedAt: now }, { merge: true });
      // ping the vendor too
      const pingBranch = await prisma.branch.findUnique({
        where: { id: order.branchId },
        select: { managerId: true },
      });
      if (pingBranch)
        await db
          .doc(`orderPings/${pingBranch.managerId}`)
          .set({ updatedAt: now }, { merge: true });

      // Phase 6 refund routing (3-way):
      //  • settlement hold  → full-gross refund + reverse hold
      //  • legacy escrow    → unchanged locked-funds refund
      //  • neither (UNPAID prepaid order) → cancel only, NO money moved
      if (await hasSettlementHold(orderId)) {
        await refundHold({
          orderId,
          buyerId: updated.userId,
          reason: "vendor_cancelled",
        });
      } else {
        const esc = await prisma.escrow.findUnique({ where: { orderId } });
        if (esc) {
          await prisma.escrow.update({
            where: { orderId },
            data: { releaseStatus: "refunded", refundedAt: new Date() },
          });
          await WalletService.moveLockedToAvailableCredit({
            userId: updated.userId,
            amount: order.totalAmount,
          });
          await WalletService.createCreditTransaction({
            userId: updated.userId,
            amount: order.totalAmount,
            type: TX_TYPE.ORDER_REFUND,
            metaData: { orderId, vendorId: order.vendorId },
          });
        }
        // else: unpaid prepaid order — nothing to refund.
      }

      await recalculateVendorMetrics(order.vendorId);
    }

    updated = await prisma.order.update({
      where: { id: orderId },
      data: { status },
      include: { items: true },
    });

    const user = await prisma.user.findUnique({
      where: { id: order.userId },
      select: { notificationToken: true },
    });

    if (user?.notificationToken) {
      await notify(
        user.notificationToken,
        "Order Status Updated",
        "Your order status has been updated.",
      );
    }

    res.json(updated);
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const cancelAppeal = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { branch: true },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.userId !== userId && order.branch.managerId !== userId)
      return res.status(403).json({ message: "Forbidden" });
    if (order.status !== "appealed")
      return res.status(400).json({ message: "Order is not under appeal" });

    // Restore auto-release window from now, using the vendor's trust-based
    // settlement delay (fail-open to AppConfig.autoReleaseHours).
    const hours = await getVendorSettlementDelayHours(order.vendorId);
    const autoReleaseAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    if (order.paymentMethod == "pay_on_delivery") {
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "delivered" },
      });
    } else {
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "delivered", escrowStatus: "held" },
      });
    }

    if (await hasSettlementHold(orderId)) {
      // Phase 6: unfreeze the hold and restart the settlement clock from now.
      await unfreezeHold(orderId);
    } else {
      await prisma.escrow.update({
        where: { orderId },
        data: { releaseStatus: "held", autoReleaseAt },
      });
    }

    // After: updated = await prisma.order.update({ where: { id: orderId }, data: { status }, ... });
    const db = admin.firestore();
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db
      .doc(`orderPings/${order.userId}`)
      .set({ updatedAt: now }, { merge: true });
    // ping the vendor too
    const pingBranch = await prisma.branch.findUnique({
      where: { id: order.branchId },
      select: { managerId: true },
    });
    if (pingBranch)
      await db
        .doc(`orderPings/${pingBranch.managerId}`)
        .set({ updatedAt: now }, { merge: true });

    res.json({ message: "Appeal cancelled. Settlement timer restored." });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

const concedeAppeal = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    const { orderId } = req.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { branch: true },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.status !== "appealed")
      return res.status(400).json({ message: "Order is not under appeal" });

    const isBuyer = order.userId === userId;
    const isManager = order.branch.managerId === userId;
    if (!isBuyer && !isManager)
      return res.status(403).json({ message: "Unauthorized" });

    if (order.appealedBy === userId)
      return res
        .status(400)
        .json({ message: "You cannot concede your own appeal" });

    const buyerAppealed = order.appealedBy === order.userId;
    const usesHold = await hasSettlementHold(orderId);

    if (buyerAppealed) {
      // Vendor concedes → buyer wins → refund
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "cancelled", escrowStatus: "refunded" },
      });
      if (usesHold) {
        // Phase 6: reverse the hold; buyer made whole for the FULL gross.
        await refundHold({
          orderId,
          buyerId: order.userId,
          reason: "appeal_conceded",
        });
      } else {
        await prisma.escrow.update({
          where: { orderId },
          data: { releaseStatus: "refunded", refundedAt: new Date() },
        });
        await WalletService.moveLockedToAvailableCredit({
          userId: order.userId,
          amount: order.totalAmount,
        });
        await WalletService.createCreditTransaction({
          userId: order.userId,
          amount: order.totalAmount,
          type: TX_TYPE.ORDER_REFUND,
          metaData: { orderId, vendorId: order.vendorId },
        });
      }
    } else {
      // Buyer concedes → vendor wins → release
      const vendor = await prisma.vendor.findUnique({
        where: { id: order.vendorId },
        include: { user: true },
      });
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "completed", escrowStatus: "released" },
      });
      if (usesHold) {
        // Phase 6: settle the hold to the merchant's wallet (NET).
        await releaseHold(orderId);
        await recalculateVendorMetrics(order.vendorId);
      } else {
        await prisma.escrow.update({
          where: { orderId },
          data: { releaseStatus: "released", releasedAt: new Date() },
        });
        await WalletService.creditAvailableBalance({
          userId: vendor!.ownerId,
          amount: order.totalAmount,
        });
        await WalletService.createCreditTransaction({
          userId: vendor!.ownerId,
          amount: order.totalAmount,
          type: TX_TYPE.ORDER_PAYMENT,
          metaData: { orderId, vendorId: vendor!.id },
        });
        await WalletService.releaseEscow({
          userId: order.userId,
          amount: order.totalAmount,
          orderId: order.id,
        });
        await recalculateVendorMetrics(order.vendorId);
      }
    }

    // Notifications
    const buyer = await prisma.user.findUnique({
      where: { id: order.userId },
      select: { notificationToken: true },
    });
    const vendor = await prisma.vendor.findUnique({
      where: { id: order.vendorId },
      include: { user: { select: { notificationToken: true } } },
    });

    if (buyerAppealed) {
      if (buyer?.notificationToken)
        await notify(
          buyer.notificationToken,
          "Appeal Accepted",
          "Your appeal was accepted. Your funds have been refunded.",
        );
      if (vendor?.user.notificationToken)
        await notify(
          vendor.user.notificationToken,
          "Appeal Conceded",
          "You accepted the buyer's appeal. Funds have been refunded.",
        );
    } else {
      if (buyer?.notificationToken)
        await notify(
          buyer.notificationToken,
          "Appeal Conceded",
          "You accepted the vendor's appeal. Payment has been released.",
        );
      if (vendor?.user.notificationToken)
        await notify(
          vendor.user.notificationToken,
          "Appeal Resolved",
          "The buyer accepted your appeal. Payment released to your wallet.",
        );
    }

    // After: updated = await prisma.order.update({ where: { id: orderId }, data: { status }, ... });
    const db = admin.firestore();
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db
      .doc(`orderPings/${order.userId}`)
      .set({ updatedAt: now }, { merge: true });
    // ping the vendor too
    const pingBranch = await prisma.branch.findUnique({
      where: { id: order.branchId },
      select: { managerId: true },
    });
    if (pingBranch)
      await db
        .doc(`orderPings/${pingBranch.managerId}`)
        .set({ updatedAt: now }, { merge: true });

    res.json({ message: "Appeal conceded successfully" });
  } catch (e: any) {
    res.status(500).json({ message: e.message });
  }
};

const confirmPodReceived = async (req: any, res: any) => {
  try {
    const userId = req.user?.id;

    const { orderId } = req.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ message: "Not found" });
    if (order.paymentMethod !== "pay_on_delivery")
      return res.status(400).json({ message: "Not a POD order" });
    if (order.status !== "delivered")
      return res.status(400).json({ message: "Order not delivered yet" });

    const config = await prisma.appConfig.findFirst();
    const commissionPercent = config?.commissionPercent ?? 5;
    const commission = order.subtotal * (commissionPercent / 100);

    // Mark POD confirmed and deduct commission
    // Commission is owed — log it for reconciliation
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "completed", podConfirmed: true },
    });

    // Log commission debt (you collect this separately)
    await admin.firestore().collection("podCommissions").add({
      orderId: order.id,
      vendorId: order.vendorId,
      subtotal: order.subtotal,
      commission,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // After: updated = await prisma.order.update({ where: { id: orderId }, data: { status }, ... });
    const db = admin.firestore();
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db
      .doc(`orderPings/${order.userId}`)
      .set({ updatedAt: now }, { merge: true });
    // ping the vendor too
    const pingBranch = await prisma.branch.findUnique({
      where: { id: order.branchId },
      select: { managerId: true },
    });
    if (pingBranch)
      await db
        .doc(`orderPings/${pingBranch.managerId}`)
        .set({ updatedAt: now }, { merge: true });

    res.json({
      message: "POD confirmed. Commission due: ₦" + commission.toFixed(2),
    });
  } catch (e: any) {
    res.status(401).json({ message: e.message });
  }
};

export default {
  placeOrder,
  getMyOrders,
  getOrderById,
  confirmDelivery,
  appealOrder,
  getManagerOrders,
  updateOrderStatus,
  cancelAppeal,
  concedeAppeal,
  confirmPodReceived,
};