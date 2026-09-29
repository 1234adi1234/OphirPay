// SPDX-License-Identifier: MIT

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-session", () => ({
  getAuthContext: vi.fn(),
}));

vi.mock("@/lib/contracts", () => ({
  DEFAULT_CONTRACT_ID: "CB...TEST",
  CHAIN_READ_SOURCE: "G...TEST",
  simulateContractCall: vi.fn(),
}));

import { GET } from "@/app/api/pause-state/route";
import { getAuthContext } from "@/lib/auth-session";
import { simulateContractCall, type SimulateResult } from "@/lib/contracts";

const mockedAuth = vi.mocked(getAuthContext);
const mockedSimulate = vi.mocked(simulateContractCall);

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockResolvedValue({ userId: "usr_1" });
});

describe("GET /api/pause-state (apiHandler migration)", () => {
  it("returns 401 when unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/pause-state"));
    expect(res.status).toBe(401);
  });

  it("returns pause state when contract simulation succeeds", async () => {
    const successPaused: SimulateResult = {
      status: "SIMULATED",
      returnValue: true,
    };
    const successScopes: SimulateResult = {
      status: "SIMULATED",
      returnValue: [1, 2],
    };

    mockedSimulate
      .mockResolvedValueOnce(successPaused)
      .mockResolvedValueOnce(successScopes);

    const res = await GET(new Request("http://localhost/api/pause-state"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.paused).toBe(true);
    expect(json.data.available).toBe(true);
    expect(json.data.scopes).toEqual([1, 2]);
  });

  it("returns unknown state when simulation fails", async () => {
    const failure: SimulateResult = {
      status: "SIMULATION_FAILED",
      returnValue: null,
      error: "Contract unreachable",
    };

    mockedSimulate.mockResolvedValueOnce(failure);

    const res = await GET(new Request("http://localhost/api/pause-state"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.paused).toBe("unknown");
    expect(json.data.available).toBe(false);
    expect(json.data.error).toBe("Contract unreachable");
  });
});

