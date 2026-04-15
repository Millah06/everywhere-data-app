/*
  Warnings:

  - You are about to drop the column `imageUrl` on the `MenuItem` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "MenuItem" DROP COLUMN "imageUrl",
ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[];
