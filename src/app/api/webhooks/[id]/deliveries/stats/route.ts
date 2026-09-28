// SPDX-License-Identifier: MIT

import prisma from "@/lib/prisma";
import {
  successResponse,
  badRequestError,
  unauthorizedError,
  handleApiError,
} from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth-session";
import { getMetricsSnapshot } from "@/lib/metrics-counters";

/**
 * GET /api/webhooks/[id]/deliveries/stats
 *
 * Expose attempt and final-outcome metrics, as well as dead-letter counts
 * for dashboard consumption.
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

    const [totalDeliveries, successfulDeliveries, failedDeliveries, deadLetterDeliveries] =
      await Promise.all([
        prisma.webhookDelivery.count({ where: { webhookId: webhook.id } }),
        prisma.webhookDelivery.count({ where: { webhookId: webhook.id, status: "SUCCESS" } }),
        prisma.webhookDelivery.count({ where: { webhookId: webhook.id, status: "FAILED" } }),
        prisma.webhookDelivery.count({
          where: {
            webhookId: webhook.id,
            OR: [{ status: "DEAD_LETTER" }, { isDeadLettered: true }],
          },
        }),
      ]);

    const globalMetrics = getMetricsSnapshot();

    return successResponse({
      webhookId: webhook.id,
      counts: {
        total: totalDeliveries,
        successful: successfulDeliveries,
        failed: failedDeliveries,
        deadLetter: deadLetterDeliveries,
      },
      metrics: {
        webhooks_delivered_total: globalMetrics.webhooks_delivered_total,
        webhooks_failed_total: globalMetrics.webhooks_failed_total,
        webhooks_dead_letter_total: globalMetrics.webhooks_dead_letter_total,
        delivery_attempts: globalMetrics.delivery_attempts.filter(
          (m) => m.delivery_type === "webhook",
        ),
        delivery_final_outcomes: globalMetrics.delivery_final_outcomes.filter(
          (m) => m.delivery_type === "webhook",
        ),
      },
    });
  } catch (err) {
    return handleApiError(err, "GET /api/webhooks/[id]/deliveries/stats");
  }
}
