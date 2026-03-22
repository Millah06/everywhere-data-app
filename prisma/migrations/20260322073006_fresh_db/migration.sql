-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN     "coverPhotoUrl" TEXT NOT NULL DEFAULT '';

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
