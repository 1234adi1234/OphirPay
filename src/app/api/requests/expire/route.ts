// SPDX-License-Identifier: MIT
import { withMetrics } from "@/lib/metrics-middleware";
import { withRequestLogging } from "@/lib/request-logging";
import { successResponse, handleApiError } from "@/lib/api-response";
import { verifyCsrf } from "@/lib/csrf";
import { transitionOverduePaymentRequests } from "@/lib/payment-request-expiration";

/**
 * Sweeps and transitions overdue payment requests (issue #810).
 * Can be triggered via cron or internal scheduling.
 */
export const POST = withMetrics(
  "POST /api/requests/expire",
  withRequestLogging(async function POST(request: Request) {
    try {
      const csrfError = verifyCsrf(request);
      if (csrfError) return csrfError;

      const result = await transitionOverduePaymentRequests();
      return successResponse(result);
    } catch (err) {
      return handleApiError(err, "POST /api/requests/expire");
    }
  })
);
