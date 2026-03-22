-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('processing', 'success', 'failed');

-- AlterTable AppConfig (bonus + funding fee columns)
ALTER TABLE "AppConfig" ADD COLUMN IF NOT EXISTS "fundingFees" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "AppConfig" ADD COLUMN IF NOT EXISTS "bonusAirtime" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "AppConfig" ADD COLUMN IF NOT EXISTS "bonusData" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "AppConfig" ADD COLUMN IF NOT EXISTS "bonusCable" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "AppConfig" ADD COLUMN IF NOT EXISTS "bonusElectric" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable Transaction
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "humanRef" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "transferId" TEXT;

-- CreateTable Transfer
CREATE TABLE IF NOT EXISTS "Transfer" (
    "id" TEXT NOT NULL,
    "senderId" TEXT,
    "receiverId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'processing',
    "clientRequestId" TEXT,
    "humanRef" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'wallet',
    "paystackRecipient" TEXT,
    "metaData" JSONB,
    "providerResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Transfer_clientRequestId_key" ON "Transfer"("clientRequestId");
CREATE INDEX IF NOT EXISTS "Transfer_senderId_idx" ON "Transfer"("senderId");
CREATE INDEX IF NOT EXISTS "Transfer_receiverId_idx" ON "Transfer"("receiverId");
CREATE INDEX IF NOT EXISTS "Transfer_status_idx" ON "Transfer"("status");

-- CreateTable Post
CREATE TABLE IF NOT EXISTS "Post" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL DEFAULT 'Anonymous',
    "userAvatar" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT,
    "hashtags" TEXT[],
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "rewardCount" INTEGER NOT NULL DEFAULT 0,
    "rewardPointsTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "isBoosted" BOOLEAN NOT NULL DEFAULT false,
    "boostExpiresAt" TIMESTAMP(3),
    "algorithmScore" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "isRepost" BOOLEAN NOT NULL DEFAULT false,
    "originalPostId" TEXT,
    "originalUserName" TEXT,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Post_userId_createdAt_idx" ON "Post"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Post_algorithmScore_createdAt_idx" ON "Post"("algorithmScore", "createdAt");
CREATE INDEX IF NOT EXISTS "Post_isBoosted_createdAt_idx" ON "Post"("isBoosted", "createdAt");
CREATE INDEX IF NOT EXISTS "Post_createdAt_idx" ON "Post"("createdAt");

-- CreateTable PostLike
CREATE TABLE IF NOT EXISTS "PostLike" (
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostLike_pkey" PRIMARY KEY ("postId","userId")
);

CREATE INDEX IF NOT EXISTS "PostLike_userId_idx" ON "PostLike"("userId");

-- CreateTable PostComment
CREATE TABLE IF NOT EXISTS "PostComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL DEFAULT 'Anonymous',
    "userAvatar" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PostComment_postId_createdAt_idx" ON "PostComment"("postId", "createdAt");

-- CreateTable SavedPost
CREATE TABLE IF NOT EXISTS "SavedPost" (
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedPost_pkey" PRIMARY KEY ("userId","postId")
);

CREATE INDEX IF NOT EXISTS "SavedPost_userId_savedAt_idx" ON "SavedPost"("userId", "savedAt");

-- CreateTable Repost
CREATE TABLE IF NOT EXISTS "Repost" (
    "id" TEXT NOT NULL,
    "repostPostId" TEXT NOT NULL,
    "originalPostId" TEXT NOT NULL,
    "reposterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Repost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Repost_repostPostId_key" ON "Repost"("repostPostId");
CREATE INDEX IF NOT EXISTS "Repost_originalPostId_idx" ON "Repost"("originalPostId");
CREATE INDEX IF NOT EXISTS "Repost_reposterId_idx" ON "Repost"("reposterId");

-- CreateTable PostViewTracker
CREATE TABLE IF NOT EXISTS "PostViewTracker" (
    "postId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "lastViewedAt" TIMESTAMP(3) NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PostViewTracker_pkey" PRIMARY KEY ("postId","viewerId")
);

-- Foreign keys
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Post" ADD CONSTRAINT "Post_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PostLike" ADD CONSTRAINT "PostLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostLike" ADD CONSTRAINT "PostLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SavedPost" ADD CONSTRAINT "SavedPost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedPost" ADD CONSTRAINT "SavedPost_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PostViewTracker" ADD CONSTRAINT "PostViewTracker_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostViewTracker" ADD CONSTRAINT "PostViewTracker_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Transaction_humanRef_idx" ON "Transaction"("humanRef");
CREATE INDEX IF NOT EXISTS "Transaction_transactionRef_idx" ON "Transaction"("transactionRef");
