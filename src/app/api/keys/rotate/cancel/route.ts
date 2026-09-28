// SPDX-License-Identifier: MIT

import { withMetrics } from "@/lib/metrics-middleware";
import { withRequestLogging } from "@/lib/request-logging";
import { verifyCsrf } from "@/lib/csrf";
import { getAuthContext } from "@/lib/auth-session";
import {
  successResponse,
  badRequestError,
  unauthorizedError,
  handleApiError,
} from "@/lib/api-response";
import { cancelApiKeyRotation } from "@/lib/api-key-rotation";

/**
 * POST /api/keys/rotate/cancel — cancel key rotation and restore the original key.
 */
export const POST = withMetrics(
  "POST /api/keys/rotate/cancel",
  withRequestLogging(async function POST(request: Request) {
    try {
      const csrfError = verifyCsrf(request);
      if (csrfError) return csrfError;

      const auth = await getAuthContext(request);
      if (!auth) return unauthorizedError("Authentication required.");

      const body = (await request.json().catch(() => ({}))) as {
        id?: string;
      };

      if (!body.id || typeof body.id !== "string") {
        return badRequestError("Key ID is required");
      }

      const result = await cancelApiKeyRotation(auth.userId, body.id);
      return successResponse(result);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("Key not found") ||
          err.message.includes("No active rotation") ||
          err.message.includes("Key ID is required"))
      ) {
        return badRequestError(err.message);
      }
      return handleApiError(err, "POST /api/keys/rotate/cancel");
    }
  })
);
