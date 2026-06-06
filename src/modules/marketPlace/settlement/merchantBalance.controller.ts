import { prisma } from "../../../prisma";
import {
  getMerchantBalanceSnapshot,
  listVendorHolds,
  settlementTablesReady,
} from "./settlement.service";
import {
  getVendorTrustLevel,
  getVendorSettlementDelayHours,
} from "./settlement.rules";

/**
 * Resolve the Vendor for the current user. Mirrors how the app actually loads
 * the vendor center: `getMyVendor` resolves by `branches.some.managerId`, while
 * owner-based endpoints (toggleVisibility/updateProfile) use `ownerId`. We OR
 * both so it matches whether the user is the owner OR a branch manager — the
 * balance shown is the vendor's single (owner-held) balance either way.
 */
async function resolveMyVendor(req: any) {
  const userId = req.user?.id;
  return prisma.vendor.findFirst({
    where: {
      OR: [
        { ownerId: userId },
        { branches: { some: { managerId: userId } } },
      ],
    },
  });
}

/**
 * GET /vendor/balance
 * The merchant balance dashboard payload:
 *  • pending   — authoritative, from MerchantBalance (sum of NET on pending/frozen holds)
 *  • available — the WITHDRAWABLE figure, read live from the owner's wallet
 *                (Design B: settled funds are credited there)
 *  • paidOut   — lifetime paid-out mirror
 *  • settlementHours / trustLevel — so the UI can explain "funds clear in 48h"
 *  • holds     — recent settlement timeline rows
 */
const getBalance = async (req: any, res: any) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const vendor = await resolveMyVendor(req);
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    // Withdrawable = owner wallet available balance (source of truth).
    const fiat = await prisma.fiat.findFirst({
      where: { wallet: { userId: vendor.ownerId } },
    });
    const walletAvailable = fiat?.availableBalance ?? 0;

    const snapshot = await getMerchantBalanceSnapshot(vendor.id);
    const holds = await listVendorHolds(vendor.id, 50);
    const settlementHours = await getVendorSettlementDelayHours(vendor.id);
    const trustLevel = await getVendorTrustLevel(vendor.id);

    return res.json({
      ready: snapshot.ready,
      vendorId: vendor.id,
      pending: snapshot.pending,
      available: walletAvailable,
      settledLifetime: snapshot.settledLifetime,
      paidOut: snapshot.paidOut,
      settlementHours,
      trustLevel,
      holds: holds.map((h) => ({
        id: h.id,
        orderId: h.orderId,
        gross: h.gross,
        commission: h.commission,
        net: h.net,
        status: h.status,
        source: h.source,
        settleAt: h.settleAt,
        releasedAt: h.releasedAt,
        refundedAt: h.refundedAt,
        createdAt: h.createdAt,
      })),
    });
  } catch (e: any) {
    // Fail soft for the dashboard read — never 500 the merchant home screen.
    if (!(await settlementTablesReady())) {
      return res.json({
        ready: false,
        pending: 0,
        available: 0,
        settledLifetime: 0,
        paidOut: 0,
        holds: [],
      });
    }
    return res.status(500).json({ message: e.message });
  }
};

export default { getBalance };