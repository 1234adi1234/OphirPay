// SPDX-License-Identifier: MIT

import prisma from "@/lib/prisma";
import {
  successResponse,
  badRequestError,
  unauthorizedError,
  handleApiError,
} from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth-session";
import { verifyCsrf } from "@/lib/csrf";
import { bulkRedeliverDeadLettersSchema } from "@/lib/validation-schemas";
import {
  bulkRedeliverDeadLetters,
  getDeadLetterDeliveries,
} from "@/lib/webhook-delivery-service";

/**
 * GET /api/webhooks/[id]/deliveries/dead-letter
 *
 * Query dead-letter deliveries for a webhook subscription, retaining
 * the event payload, the last response code/body, and failure reason.
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
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit")) || 50));

    const deadLetters = await getDeadLetterDeliveries(webhook.id, limit);

    return successResponse(
      deadLetters.map((d) => ({
        id: d.id,
        eventId: d.eventId,
        eventType: d.event.event,
        eventTimestamp: d.event.timestamp.toISOString(),
        payload: d.event.data,
        status: d.status,
        isDeadLettered: d.isDeadLettered || d.status === "DEAD_LETTER",
        responseCode: d.responseCode,
        responseBody: d.responseBody,
        latencyMs: d.latencyMs,
        attempts: d.attempts,
        errorMessage: d.errorMessage,
        failureReason: d.failureReason,
        targetUrl: d.targetUrl,
        deliveredAt: d.deliveredAt.toISOString(),
      })),
      { limit, total: deadLetters.length },
    );
  } catch (err) {
    return handleApiError(err, "GET /api/webhooks/[id]/deliveries/dead-letter");
  }
}

/**
 * POST /api/webhooks/[id]/deliveries/dead-letter
 *
 * Bulk redelivery action for webhooks in the dead-letter state after
 * a subscriber resolves endpoint issues. Audited via AuditLog.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = verifyCsrf(request);
    if (csrfError) return csrfError;

    const auth = await getAuthContext(request);
    if (!auth) return unauthorizedError("Authentication required.");

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const parsed = bulkRedeliverDeadLettersSchema.safeParse(body);
    if (!parsed.success) {
      return badRequestError(parsed.error.issues.map((e) => e.message).join("; "));
    }

    const result = await bulkRedeliverDeadLetters(id, {
      userId: auth.userId,
      deliveryIds: parsed.data.deliveryIds,
      limit: parsed.data.limit,
    });

    return successResponse(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not found") || message.includes("paused")) {
      return badRequestError(message);
    }
    return handleApiError(err, "POST /api/webhooks/[id]/deliveries/dead-letter");
  }
}
