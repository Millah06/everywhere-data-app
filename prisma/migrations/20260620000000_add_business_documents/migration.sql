-- AlterTable: add businessDocuments JSON column to Vendor for multi-doc compliance uploads
ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "businessDocuments" JSONB;
