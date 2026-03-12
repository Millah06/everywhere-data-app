-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "vendorCover" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "coverPhoto" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "status" SET DEFAULT 'approved',
ALTER COLUMN "isVisible" SET DEFAULT true;
