// SPDX-License-Identifier: MIT
import { withMetrics } from "@/lib/metrics-middleware";
import { withRequestLogging } from "@/lib/request-logging";
import {
  successResponse,
  unauthorizedError,
  notFoundError,
  badRequestError,
  rateLimitError,
  handleApiError,
} from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth-session";
import { verifyCsrf } from "@/lib/csrf";
import {
  sendPaymentRequestReminder,
  ReminderRateLimitError,
  ReminderLimitExceededError,
} from "@/lib/payment-request-expiration";

export const POST = withMetrics(
  "POST /api/requests/[id]/remind",
  withRequestLogging(async function POST(
    request: Request,
    context?: { params?: Promise<{ id: string }> }
  ) {
    try {
      const csrfError = verifyCsrf(request);
      if (csrfError) return csrfError;

      const auth = await getAuthContext(request);
      if (!auth) {
        return unauthorizedError(
          "Authentication required to send payment reminders."
        );
      }

      const params = await context?.params;
      const id = params?.id;
      if (!id) {
        return badRequestError("Missing request ID");
      }

      const result = await sendPaymentRequestReminder(id, auth.userId);
      return successResponse(result);
    } catch (err) {
      if (err instanceof ReminderRateLimitError) {
        return rateLimitError(err.message, err.retryAfterSeconds);
      }
      if (err instanceof ReminderLimitExceededError) {
        return badRequestError(err.message);
      }
      if (err instanceof Error) {
        if (err.message.includes("not found")) {
          return notFoundError(err.message);
        }
        if (err.message.includes("Unauthorized")) {
          return unauthorizedError(err.message);
        }
        if (err.message.includes("Cannot send reminder")) {
          return badRequestError(err.message);
        }
      }
      return handleApiError(err, "POST /api/requests/[id]/remind");
    }
  })
);
