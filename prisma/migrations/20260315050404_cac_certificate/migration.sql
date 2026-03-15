-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "managerUid" TEXT;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "cacCertificateUrl" TEXT DEFAULT '';
