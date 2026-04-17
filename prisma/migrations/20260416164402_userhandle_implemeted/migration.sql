/*
  Warnings:

  - Added the required column `userHandle` to the `Post` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Post" 
ADD COLUMN     "originalUserHandle" TEXT;
ALTER TABLE "Post" 
ADD COLUMN     "userHandle" TEXT;
