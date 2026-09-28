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
import {
  rotateApiKey,
  confirmApiKeyRotation,
  cancelApiKeyRotation,
} from "@/lib/api-key-rotation";

/**
 * POST /api/keys/rotate — perform zero-downtime rotation for an API key.
 *
 * Supports:
 *   - Initial rotation: { id: string, name?: string, overlapHours?: number, overlapSeconds?: number, overlapWindow?: string }
 *   - Explicit confirmation: { id: string, action: "confirm" }
 *   - Explicit cancellation: { id: string, action: "cancel" }
 */
export const POST = withMetrics(
  "POST /api/keys/rotate",
  withRequestLogging(async function POST(request: Request) {
    try {
      const csrfError = verifyCsrf(request);
      if (csrfError) return csrfError;

      const auth = await getAuthContext(request);
      if (!auth) return unauthorizedError("Authentication required.");

      const body = (await request.json().catch(() => ({}))) as {
        id?: string;
        name?: string;
        overlapHours?: number;
        overlapSeconds?: number;
        overlapWindow?: string;
        action?: string;
      };

      if (!body.id || typeof body.id !== "string") {
        return badRequestError("Key ID is required");
      }

      if (body.action === "confirm") {
        const result = await confirmApiKeyRotation(auth.userId, body.id);
        return successResponse(result);
      }

      if (body.action === "cancel") {
        const result = await cancelApiKeyRotation(auth.userId, body.id);
        return successResponse(result);
      }

      const result = await rotateApiKey(auth.userId, {
        id: body.id,
        name: body.name,
        overlapHours: body.overlapHours,
        overlapSeconds: body.overlapSeconds,
        overlapWindow: body.overlapWindow,
      });

      return successResponse(result, undefined, 201);
    } catch (err) {
      if (err instanceof Error && (
        err.message.includes("Key not found") ||
        err.message.includes("Cannot rotate") ||
        err.message.includes("already undergoing rotation") ||
        err.message.includes("No active rotation") ||
        err.message.includes("not undergoing rotation")
      )) {
        return badRequestError(err.message);
      }
      return handleApiError(err, "POST /api/keys/rotate");
    }
  })
);
