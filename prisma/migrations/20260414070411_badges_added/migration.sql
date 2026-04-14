/*
  Warnings:

  - You are about to drop the column `allowFollwersToMessage` on the `UserProfile` table. All the data in the column will be lost.
  - You are about to drop the column `badges` on the `UserProfile` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "UserProfile" DROP COLUMN "allowFollwersToMessage",
DROP COLUMN "badges",
ADD COLUMN     "allowFollowersToMessage" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Badges" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kycBlue" BOOLEAN NOT NULL DEFAULT false,
    "premiumPaid" BOOLEAN NOT NULL DEFAULT false,
    "business" BOOLEAN NOT NULL DEFAULT false,
    "creatorEarnings" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Badges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Badges_profileId_key" ON "Badges"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "Badges_userId_key" ON "Badges"("userId");

-- AddForeignKey
ALTER TABLE "Badges" ADD CONSTRAINT "Badges_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Badges" ADD CONSTRAINT "Badges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
