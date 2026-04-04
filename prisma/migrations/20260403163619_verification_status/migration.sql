-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('unverified', 'pending', 'verified', 'rejected');

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'unverified';
