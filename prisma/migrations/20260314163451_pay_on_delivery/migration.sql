-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "isMainBranch" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paymentMethod" TEXT NOT NULL DEFAULT 'escrow',
ADD COLUMN     "podConfirmed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "allowsPayOnDelivery" BOOLEAN NOT NULL DEFAULT false;
