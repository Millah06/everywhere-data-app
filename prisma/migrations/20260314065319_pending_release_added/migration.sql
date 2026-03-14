-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'pendingFundRelease';

-- AlterTable
ALTER TABLE "Escrow" ADD COLUMN     "refundedAt" TIMESTAMP(3);
