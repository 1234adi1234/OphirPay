-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "rotatedFromId" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "rotatedAt" TIMESTAMP(3);
ALTER TABLE "ApiKey" ADD COLUMN "preRotationExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ApiKey_rotatedFromId_idx" ON "ApiKey"("rotatedFromId");
