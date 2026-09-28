// SPDX-License-Identifier: MIT

import prisma from "@/lib/prisma";
import {
  successResponse,
  badRequestError,
  unauthorizedError,
  handleApiError,
} from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth-session";
import { webhookDeliveriesQuerySchema } from "@/lib/validation-schemas";

/**
 * GET /api/webhooks/[id]/deliveries
 *
 * Returns delivery history for a webhook (original, replay, and dead-letter deliveries).
 * Used by the dashboard to surface delivery status and query dead-lettered deliveries.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await getAuthContext(request);
    if (!auth) return unauthorizedError("Authentication required.");

    const { id } = await params;
    const webhook = await prisma.webhook.findFirst({
      where: { id, userId: auth.userId },
      select: { id: true },
    });
    if (!webhook) return badRequestError("Webhook not found");

    const { searchParams } = new URL(request.url);
    const parsed = webhookDeliveriesQuerySchema.safeParse(
      Object.fromEntries(searchParams.entries()),
    );
    if (!parsed.success) {
      return badRequestError(parsed.error.issues.map((e) => e.message).join("; "));
    }

    const { limit, status, deadLetterOnly } = parsed.data;

    const where: Record<string, unknown> = { webhookId: webhook.id };
    if (deadLetterOnly) {
      where.OR = [
        { status: "DEAD_LETTER" },
        { isDeadLettered: true },
      ];
    } else if (status) {
      where.status = status;
    }

    const deliveries = await prisma.webhookDelivery.findMany({
      where,
      orderBy: { deliveredAt: "desc" },
      take: limit,
      select: {
        id: true,
        eventId: true,
        status: true,
        responseCode: true,
        isReplay: true,
        replayBatchId: true,
        deliveredAt: true,
        latencyMs: true,
        attempts: true,
        errorMessage: true,
        failureReason: true,
        isDeadLettered: true,
        event: {
          select: {
            event: true,
            timestamp: true,
            data: true,
          },
        },
      },
    });

    return successResponse(
      deliveries.map((d) => ({
        id: d.id,
        eventId: d.eventId,
        eventType: d.event.event,
        eventTimestamp: d.event.timestamp.toISOString(),
        status: d.status,
        responseCode: d.responseCode,
        isReplay: d.isReplay,
        replayBatchId: d.replayBatchId,
        deliveredAt: d.deliveredAt.toISOString(),
        latencyMs: d.latencyMs,
        attempts: d.attempts,
        errorMessage: d.errorMessage,
        failureReason: d.failureReason,
        isDeadLettered: d.isDeadLettered || d.status === "DEAD_LETTER",
        payload: d.event.data,
      })),
      { limit, total: deliveries.length },
    );
  } catch (err) {
    return handleApiError(err, "GET /api/webhooks/[id]/deliveries");
  }
}
