import { prisma } from "../../../prisma";
import admin from "firebase-admin";

/**
 * Realtime "ping": bump Firestore `orderPings/{uid}` docs so the buyer's and
 * vendor's listeners refetch immediately — no refresh button.
 *
 * Targets ALL parties so every listener fires regardless of how it subscribes:
 *   • buyer        → order.userId        (buyer app: watchRealtime(userId))
 *   • branch mgr   → branch.managerId    (branch-manager view)
 *   • vendor owner → vendor.ownerId      (vendor center: orderPings/{ownerId})
 *
 * Best-effort and self-contained: it must NEVER throw into the caller (a failed
 * ping must not break the money/status path).
 */
export async function pingOrderParties(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { userId: true, vendorId: true, branchId: true },
    });
    if (!order) return;

    const targets = new Set<string>();
    if (order.userId) targets.add(order.userId);

    const [branch, vendor] = await Promise.all([
      prisma.branch.findUnique({
        where: { id: order.branchId },
        select: { managerId: true },
      }),
      prisma.vendor.findUnique({
        where: { id: order.vendorId },
        select: { ownerId: true },
      }),
    ]);
    if (branch?.managerId) targets.add(branch.managerId);
    if (vendor?.ownerId) targets.add(vendor.ownerId);

    const db = admin.firestore();
    const now = admin.firestore.FieldValue.serverTimestamp();
    await Promise.all(
      [...targets].map((t) =>
        db.doc(`orderPings/${t}`).set({ updatedAt: now }, { merge: true }),
      ),
    );
  } catch (e) {
    console.error("[pingOrderParties] failed", e);
  }
}