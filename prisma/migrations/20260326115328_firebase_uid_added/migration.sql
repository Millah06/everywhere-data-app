/*
  Warnings:

  - Added the required column `ownerFirebaseUid` to the `Vendor` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "ownerFirebaseUid" TEXT NOT NULL;
