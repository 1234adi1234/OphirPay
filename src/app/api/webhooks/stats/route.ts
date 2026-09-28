// SPDX-License-Identifier: MIT

import prisma from "@/lib/prisma";
import {
  successResponse,
  unauthorizedError,
  handleApiError,
} from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth-session";
import { getMetricsSnapshot } from "@/lib/metrics-counters";

/**
 * GET /api/webhooks/stats
 *
 * Aggregate webhook delivery and dead-letter statistics across user's webhooks.
 */
export async function GET(request: Request) {
  try {
    const auth = await getAuthContext(request);
    if (!auth) return unauthorizedError("Authentication required.");

    const webhooks = await prisma.webhook.findMany({
      where: { userId: auth.userId },
      select: { id: true },
    });
    const webhookIds = webhooks.map((w) => w.id);

    const [totalDeliveries, successfulDeliveries, failedDeliveries, deadLetterDeliveries] =
      await Promise.all([
        prisma.webhookDelivery.count({ where: { webhookId: { in: webhookIds } } }),
        prisma.webhookDelivery.count({ where: { webhookId: { in: webhookIds }, status: "SUCCESS" } }),
        prisma.webhookDelivery.count({ where: { webhookId: { in: webhookIds }, status: "FAILED" } }),
        prisma.webhookDelivery.count({
          where: {
            webhookId: { in: webhookIds },
            OR: [{ status: "DEAD_LETTER" }, { isDeadLettered: true }],
          },
        }),
      ]);

    const globalMetrics = getMetricsSnapshot();

    return successResponse({
      counts: {
        totalWebhooks: webhooks.length,
        totalDeliveries,
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
    return handleApiError(err, "GET /api/webhooks/stats");
  }
}
