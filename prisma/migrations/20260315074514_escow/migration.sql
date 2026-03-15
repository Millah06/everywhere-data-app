/*
  Warnings:

  - The values [noEscosw] on the enum `EscrowStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "EscrowStatus_new" AS ENUM ('held', 'released', 'appealed', 'refunded', 'noEscrow');
ALTER TABLE "public"."Escrow" ALTER COLUMN "releaseStatus" DROP DEFAULT;
ALTER TABLE "public"."Order" ALTER COLUMN "escrowStatus" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "escrowStatus" TYPE "EscrowStatus_new" USING ("escrowStatus"::text::"EscrowStatus_new");
ALTER TABLE "Escrow" ALTER COLUMN "releaseStatus" TYPE "EscrowStatus_new" USING ("releaseStatus"::text::"EscrowStatus_new");
ALTER TYPE "EscrowStatus" RENAME TO "EscrowStatus_old";
ALTER TYPE "EscrowStatus_new" RENAME TO "EscrowStatus";
DROP TYPE "public"."EscrowStatus_old";
ALTER TABLE "Escrow" ALTER COLUMN "releaseStatus" SET DEFAULT 'held';
ALTER TABLE "Order" ALTER COLUMN "escrowStatus" SET DEFAULT 'held';
COMMIT;
