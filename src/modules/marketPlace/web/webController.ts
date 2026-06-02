// src/modules/marketPlace/web/webController.ts
//
// PHASE 1 — FOUNDATION
//
// Public (optional-auth) read endpoints that power the deep-link landing pages
// and (Phase 3) the Cloudflare SEO worker. There is NO `/public` module — these
// are plain marketPlace controllers mounted with `optionalAuthMiddleware`.
//
// Why these are SEPARATE functions from getVendorById/getBranchMenu (which 401
// on a null user): a guest hitting a shared link has `req.user === null`, and
// these handlers must respond with public-safe data rather than 401. They never
// touch `req.user` in Phase 1; Phase 3 can enrich the payload when a user is
// present.
//
// ORDERING REQUIREMENT: the additive Prisma fields/relations referenced here
// (`vendor.trustProfile`, `vendor.fulfillmentTypes`) only exist AFTER the
// `phase1_foundation` migration + `prisma generate`. Apply the schema changes
// and regenerate the client BEFORE wiring these routes, or TypeScript will
// (correctly) fail to compile. See PHASE1_BACKEND_EDITS.md §ordering.
//
import { prisma } from "../../../prisma";

// GET /web/store/:vendorId  (optionalAuthMiddleware)
// Returns a public store payload: vendor header + branches + the available
// menu items aggregated across all branches. 404 for hidden/unapproved/
// trust-level-0 stores so private or de-listed merchants never leak.
export const getStorePublic = async (req: any, res: any) => {
  try {
    const { vendorId } = req.params;

    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        branches: { include: { deliveryZones: true, menuItems: true } },
        trustProfile: true, // additive (phase1_foundation)
      },
    });

    if (!vendor) {
      return res.status(404).json({ message: "Store not found" });
    }

    // Hidden or not-yet-approved stores are not publicly viewable.
    if (!vendor.isVisible || vendor.status !== "approved") {
      return res.status(404).json({ message: "Store not available" });
    }

    // Trust gate: a level-0 (unverified) merchant cannot sell publicly. Only
    // enforced when a profile EXISTS, so approved vendors that predate the
    // phase1 seed are not accidentally hidden before the backfill runs.
    if (vendor.trustProfile && vendor.trustProfile.level === 0) {
      return res.status(404).json({ message: "Store not available" });
    }

    // Aggregate available items across branches (menu hangs off branches, not
    // the vendor — there is no Vendor.menus relation).
    const items = vendor.branches.flatMap((b: any) =>
      (b.menuItems ?? [])
        .filter((m: any) => m.isAvailable)
        .map((m: any) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          price: m.price,
          images: m.images,
          branchId: m.branchId,
        })),
    );

    return res.json({
      id: vendor.id,
      name: vendor.name,
      description: vendor.description,
      logo: vendor.logo,
      coverPhoto: vendor.coverPhoto,
      rating: vendor.rating,
      verified: vendor.verified,
      // additive field; defaults to delivery-only for legacy rows.
      fulfillmentTypes: (vendor as any).fulfillmentTypes ?? ["delivery"],
      branches: vendor.branches.map((b: any) => ({
        id: b.id,
        state: b.state,
        lga: b.lga,
        area: b.area,
        street: b.street,
        isMainBranch: b.isMainBranch,
        estimatedDeliveryTime: b.estimatedDeliveryTime,
        deliveryZones: b.deliveryZones,
      })),
      items,
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

// GET /web/product/:menuItemId  (optionalAuthMiddleware)
// Returns a single product plus enough owning-store context for the Flutter
// landing page's "View in store" CTA. 404 if the item is unavailable or its
// store is hidden/unapproved/trust-level-0.
export const getProductPublic = async (req: any, res: any) => {
  try {
    const { menuItemId } = req.params;

    const item = await prisma.menuItem.findUnique({
      where: { id: menuItemId },
      include: {
        branch: {
          include: {
            vendor: { include: { trustProfile: true } }, // trustProfile additive
          },
        },
      },
    });

    if (!item) {
      return res.status(404).json({ message: "Product not found" });
    }

    const vendor = item.branch.vendor;

    if (!item.isAvailable || !vendor.isVisible || vendor.status !== "approved") {
      return res.status(404).json({ message: "Product not available" });
    }

    if (vendor.trustProfile && vendor.trustProfile.level === 0) {
      return res.status(404).json({ message: "Product not available" });
    }

    return res.json({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      images: item.images,
      isAvailable: item.isAvailable,
      branchId: item.branchId,
      vendorId: vendor.id, // ← Flutter routes to /store/{vendorId} from here
      vendorName: vendor.name,
      vendorLogo: vendor.logo,
    });
  } catch (e: any) {
    return res.status(500).json({ message: e.message });
  }
};

export default { getStorePublic, getProductPublic };