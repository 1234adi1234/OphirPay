// SPDX-License-Identifier: MIT

import crypto from "crypto";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  deliverWebhook,
  type WebhookDeliveryResult,
  type WebhookDeliveryDetails,
} from "@/lib/webhook-deliver";
import {
  recordWebhookDelivery,
  toWebhookPayload,
  getDeadLetterDeliveries,
} from "@/lib/webhook-event-store";
import type { DeliveryStatus } from "@prisma/client";

export interface RecordDeliveryOptions {
  responseCode?: number;
  isReplay?: boolean;
  replayBatchId?: string;
  latencyMs?: number;
  attempts?: number;
  errorMessage?: string;
  failureReason?: string;
  isDeadLettered?: boolean;
  status?: DeliveryStatus;
  responseBody?: string;
  requestBody?: string;
  canonicalBody?: string;
  signature?: string;
  requestHeaders?: string;
  durationMs?: number;
  error?: string;
  targetUrl?: string;
  test?: boolean;
}

/** Map deliverWebhook output into a delivery ledger row. */
export async function persistDeliveryResult(
  webhookId: string,
  eventId: string,
  result: WebhookDeliveryResult,
  options?: Omit<RecordDeliveryOptions, "responseCode" | "latencyMs" | "attempts" | "errorMessage">,
): Promise<string> {
  const details = "request" in result ? (result as WebhookDeliveryDetails) : null;
  const isDeadLetter =
    options?.isDeadLettered ??
    result.isDeadLettered ??
    (!result.success && options?.status === "DEAD_LETTER");
  const status: DeliveryStatus =
    options?.status ??
    (result.success ? "SUCCESS" : isDeadLetter ? "DEAD_LETTER" : "FAILED");

  return recordWebhookDelivery(
    webhookId,
    eventId,
    status,
    {
      responseCode: result.statusCode,
      latencyMs: result.latencyMs,
      attempts: result.attempts,
      errorMessage: result.errorMessage,
      failureReason: result.failureReason,
      isDeadLettered: isDeadLetter,
      responseBody: details?.responseBody ?? options?.responseBody,
      requestBody: details?.request?.body ?? options?.requestBody,
      canonicalBody: details?.request?.canonicalBody ?? options?.canonicalBody,
      signature: details?.request?.signature ?? options?.signature,
      requestHeaders: details?.request?.headers ? JSON.stringify(details.request.headers) : options?.requestHeaders,
      durationMs: details?.durationMs ?? result.latencyMs,
      error: details?.error ?? result.errorMessage,
      ...options,
    },
  );
}

export interface BulkRedeliverOptions {
  deliveryIds?: string[];
  limit?: number;
  userId: string;
}

export interface BulkRedeliveryItem {
  priorDeliveryId: string;
  newDeliveryId: string;
  status: DeliveryStatus;
  statusCode?: number;
  latencyMs: number;
  attempts: number;
  errorMessage?: string;
  failureReason?: string;
  success: boolean;
}

export interface BulkRedeliverResult {
  batchId: string;
  totalSelected: number;
  succeeded: number;
  failed: number;
  deliveries: BulkRedeliveryItem[];
}

/**
 * Bulk redelivery from the dead-letter state after a subscriber fixes their endpoint.
 * Audited via off-chain AuditLog.
 */
export async function bulkRedeliverDeadLetters(
  webhookId: string,
  options: BulkRedeliverOptions,
): Promise<BulkRedeliverResult> {
  const webhook = await prisma.webhook.findFirst({
    where: { id: webhookId, userId: options.userId },
  });
  if (!webhook) {
    throw new Error("Webhook not found");
  }
  if (!webhook.isActive) {
    throw new Error("Webhook is paused — activate it before redelivering");
  }

  const boundedLimit = Math.min(100, Math.max(1, options.limit ?? 50));
  const whereClause: Record<string, unknown> = {
    webhookId,
    OR: [
      { status: "DEAD_LETTER" },
      { isDeadLettered: true },
    ],
  };

  if (options.deliveryIds && options.deliveryIds.length > 0) {
    whereClause.id = { in: options.deliveryIds };
  }

  const deadLetters = await prisma.webhookDelivery.findMany({
    where: whereClause,
    orderBy: { deliveredAt: "desc" },
    take: boundedLimit,
    include: {
      event: {
        select: { id: true, event: true, timestamp: true, data: true },
      },
    },
  });

  const batchId = crypto.randomUUID();
  const deliveryResults: BulkRedeliveryItem[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const prior of deadLetters) {
    const payload = toWebhookPayload(prior.event);
    const result = await deliverWebhook(webhook.url, webhook.secret, payload);
    const newDeliveryId = await persistDeliveryResult(webhook.id, prior.eventId, result, {
      isReplay: true,
      replayBatchId: batchId,
    });

    if (result.success) {
      succeeded++;
      await prisma.webhookDelivery.update({
        where: { id: prior.id },
        data: { isDeadLettered: false },
      });
    } else {
      failed++;
    }

    deliveryResults.push({
      priorDeliveryId: prior.id,
      newDeliveryId,
      status: result.success ? "SUCCESS" : "DEAD_LETTER",
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      attempts: result.attempts,
      errorMessage: result.errorMessage,
      failureReason: result.failureReason,
      success: result.success,
    });
  }

  // Audit trail entry for the bulk redelivery action
  await prisma.auditLog.create({
    data: {
      action: "webhook:dead_letter_bulk_redeliver",
      actor: options.userId,
      target: webhook.id,
      details: {
        batchId,
        totalSelected: deadLetters.length,
        succeeded,
        failed,
        deliveryIds: deadLetters.map((d) => d.id),
      },
    },
  });

  logger.info("Bulk redelivery from dead-letter queue completed", {
    webhookId: webhook.id,
    batchId,
    total: deadLetters.length,
    succeeded,
    failed,
  });

  return {
    batchId,
    totalSelected: deadLetters.length,
    succeeded,
    failed,
    deliveries: deliveryResults,
  };
}

export { toWebhookPayload, deliverWebhook, getDeadLetterDeliveries };
export type { WebhookDeliveryResult };
