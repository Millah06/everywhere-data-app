import { prisma } from "../../prisma";

// utils/branchAuth.ts
export const requireMainBranch = async (userId: string, vendorId: string) => {
  const vendor = await prisma.vendor.findFirst({ where: { id: vendorId } });
  if (!vendor) throw new Error("Vendor not found");

  // Owner always passes
  if (vendor.ownerId === userId) return vendor;

  // Non-owners must be manager of the main branch
  const mainBranch = await prisma.branch.findFirst({
    where: { vendorId, isMainBranch: true, managerUid: userId },
  });
  if (!mainBranch) throw new Error("Only the main branch manager can perform this action");

  return vendor;
};