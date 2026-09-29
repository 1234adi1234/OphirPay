// SPDX-License-Identifier: MIT

import { successResponse } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { simulateContractCall, DEFAULT_CONTRACT_ID, CHAIN_READ_SOURCE } from "@/lib/contracts";

/**
 * GET /api/pause-state — current pause state from the Soroban contract.
 *
 * Simulates two read-only calls:
 *   - OphirPayContract.is_paused()          → the global emergency flag
 *   - OphirPayContract.get_paused_scopes()  → ids of individually paused scopes
 *
 * Response shapes:
 *   { paused: boolean, available: true, scopes: number[] }  — known state
 *   { paused: "unknown", available: false, scopes: [], error?: string }
 *     — simulation failed / unreachable
 */
export const GET = apiHandler({
  name: "GET /api/pause-state",
}, async () => {
  const result = await simulateContractCall(
    DEFAULT_CONTRACT_ID,
    "is_paused",
    CHAIN_READ_SOURCE
  );

  if (result.status === "SIMULATION_FAILED") {
    // Contract not deployed or unreachable — explicitly report unknown state
    return successResponse({
      paused: "unknown" as const,
      available: false,
      scopes: [] as number[],
      error: result.error,
    });
  }

  // Scoped pause is additive information: a failure to read the scope list
  // must never hide the global state we already have, so it degrades to [].
  let scopes: number[] = [];
  try {
    const scopesResult = await simulateContractCall(
      DEFAULT_CONTRACT_ID,
      "get_paused_scopes",
      CHAIN_READ_SOURCE
    );
    if (
      scopesResult.status !== "SIMULATION_FAILED" &&
      Array.isArray(scopesResult.returnValue)
    ) {
      scopes = scopesResult.returnValue
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0);
    }
  } catch {
    scopes = [];
  }

  return successResponse({
    paused: result.returnValue === true,
    available: true,
    scopes,
  });
});
