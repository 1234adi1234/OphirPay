-- AlterEnum
ALTER TYPE "DeliveryStatus" ADD VALUE 'DEAD_LETTER';

-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN "failureReason" TEXT,
ADD COLUMN "isDeadLettered" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "WebhookDelivery_webhookId_status_idx" ON "WebhookDelivery"("webhookId", "status");
CREATE INDEX "WebhookDelivery_webhookId_isDeadLettered_idx" ON "WebhookDelivery"("webhookId", "isDeadLettered");
