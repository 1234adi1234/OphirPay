"use client";
// SPDX-License-Identifier: MIT


import { useCallback } from "react";
import { captureError, captureMessage } from "@/lib/sentry";

/**
 * React hook wrapping the error tracking integration.
 * Provides a stable callback for capturing errors from component event handlers.
 *
 * @example
 * Capture a failed wallet-connect attempt with extra context:
 *
 * ```tsx
 * function ConnectButton() {
 *   const { trackError } = useErrorTracker("ConnectButton");
 *   const { connect } = useWallet();
 *
 *   return (
 *     <button
 *       onClick={async () => {
 *         try {
 *           await connect("freighter");
 *         } catch (err) {
 *           trackError(err as Error, { attempt: "freighter" });
 *         }
 *       }}
 *     >
 *       Connect
 *     </button>
 *   );
 * }
 * ```
 */
export function useErrorTracker(
  componentOrOptions?: string | { component?: string; segment?: string },
) {
  const component =
    typeof componentOrOptions === "string"
      ? componentOrOptions
      : componentOrOptions?.component;
  const segment =
    typeof componentOrOptions === "object" ? componentOrOptions?.segment : undefined;

  const trackError = useCallback(
    (error: Error, extra?: Record<string, unknown>) => {
      captureError(error, {
        component,
        tags: segment ? { segment } : undefined,
        extra: { ...(extra || {}), ...(segment ? { segment } : {}) },
      });
    },
    [component, segment],
  );

  const trackMessage = useCallback(
    (message: string, level: "info" | "warning" | "error" = "error") => {
      captureMessage(message, level);
    },
    [],
  );

  return { trackError, trackMessage };
}

