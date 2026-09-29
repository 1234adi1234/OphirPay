// SPDX-License-Identifier: MIT

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import {
  apiHandler,
  withApiHandler,
  withAuth,
  withValidation,
  withMutatingRoute,
  extractQueryParams,
} from "@/lib/api-handler";
import { successResponse, forbiddenError } from "@/lib/api-response";
import { ERROR_CODES } from "@/lib/error-codes";


// Mock dependencies
vi.mock("@/lib/auth-session", () => ({
  getAuthContext: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  requireScopes: vi.fn(),
  extractApiKey: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  getRateLimitStore: vi.fn(),
}));

vi.mock("@/lib/csrf", () => ({
  verifyCsrf: vi.fn(),
}));

import { getAuthContext } from "@/lib/auth-session";
import { requireScopes } from "@/lib/api-auth";
import { getRateLimitStore } from "@/lib/rate-limit";
import { verifyCsrf } from "@/lib/csrf";

const mockedGetAuth = vi.mocked(getAuthContext);
const mockedRequireScopes = vi.mocked(requireScopes);
const mockedVerifyCsrf = vi.mocked(verifyCsrf);
const mockedGetRateLimitStore = vi.mocked(getRateLimitStore);

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAuth.mockResolvedValue({ userId: "usr_test123", publicKey: "GABC123" });
  mockedVerifyCsrf.mockReturnValue(null); // Valid CSRF by default
});

describe("apiHandler core wrapper", () => {
  describe("Authentication pipeline", () => {
    it("enforces authentication by default and returns 401 when missing", async () => {
      mockedGetAuth.mockResolvedValue(null);

      const handler = apiHandler({ name: "GET /api/test" }, async ({ auth }) => {
        return successResponse({ user: auth.userId });
      });

      const res = await handler(new Request("http://localhost/api/test"));
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe(ERROR_CODES.UNAUTHORIZED);
    });

    it("passes authenticated context to inner handler when session exists", async () => {
      mockedGetAuth.mockResolvedValue({ userId: "usr_abc", publicKey: "G123" });

      const handler = apiHandler({ name: "GET /api/test" }, async ({ auth }) => {
        return successResponse({ user: auth.userId });
      });

      const res = await handler(new Request("http://localhost/api/test"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.user).toBe("usr_abc");
    });

    it("allows explicit opt-out with auth: false for public endpoints", async () => {
      mockedGetAuth.mockResolvedValue(null);

      const handler = apiHandler(
        { name: "GET /api/public", auth: false },
        async ({ auth }) => {
          return successResponse({ authStatus: auth ? "authenticated" : "anonymous" });
        }
      );

      const res = await handler(new Request("http://localhost/api/public"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.authStatus).toBe("anonymous");
    });

    it("allows explicit opt-out with auth: { public: true }", async () => {
      mockedGetAuth.mockResolvedValue(null);

      const handler = apiHandler(
        { name: "GET /api/public", auth: { public: true, reason: "Public monitoring" } },
        async ({ auth }) => {
          return successResponse({ auth: auth ?? null });
        }
      );

      const res = await handler(new Request("http://localhost/api/public"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.auth).toBeNull();
    });

    it("enforces required scopes and returns 403 on insufficient scope", async () => {
      mockedRequireScopes.mockResolvedValue(
        forbiddenError("Missing scope")
      );

      const handler = apiHandler(
        { name: "POST /api/admin", auth: { scopes: ["write:payments"] } },
        async () => successResponse({ ok: true })
      );

      const res = await handler(
        new Request("http://localhost/api/admin", { method: "POST" })
      );
      expect(res.status).toBe(403);
      expect(mockedRequireScopes).toHaveBeenCalledWith(expect.any(Request), ["write:payments"]);
    });

  });

  describe("CSRF verification pipeline", () => {
    it("enforces CSRF for mutating methods (POST, PUT, PATCH, DELETE) by default", async () => {
      mockedVerifyCsrf.mockReturnValue(
        Response.json(
          { success: false, error: { code: "CSRF_INVALID", message: "Invalid CSRF" } },
          { status: 403 }
        )
      );

      const handler = apiHandler({ name: "POST /api/pay" }, async () => {
        return successResponse({ paid: true });
      });

      const res = await handler(
        new Request("http://localhost/api/pay", { method: "POST" })
      );
      expect(res.status).toBe(403);
      expect(mockedVerifyCsrf).toHaveBeenCalledTimes(1);
    });

    it("does not enforce CSRF for GET requests", async () => {
      const handler = apiHandler({ name: "GET /api/items" }, async () => {
        return successResponse({ items: [] });
      });

      const res = await handler(new Request("http://localhost/api/items"));
      expect(res.status).toBe(200);
      expect(mockedVerifyCsrf).not.toHaveBeenCalled();
    });

    it("permits explicit CSRF opt-out on machine mutating routes", async () => {
      const handler = apiHandler(
        {
          name: "POST /api/cron",
          csrf: { exempt: true, reason: "Cron secret authorization" },
        },
        async () => successResponse({ run: true })
      );

      const res = await handler(
        new Request("http://localhost/api/cron", { method: "POST" })
      );
      expect(res.status).toBe(200);
      expect(mockedVerifyCsrf).not.toHaveBeenCalled();
    });
  });

  describe("HTTP method guard", () => {
    it("returns 405 when request method is not allowed", async () => {
      const handler = apiHandler(
        { name: "GET /api/item", method: "GET" },
        async () => successResponse({ item: 1 })
      );

      const res = await handler(
        new Request("http://localhost/api/item", { method: "DELETE" })
      );
      expect(res.status).toBe(405);
      const json = await res.json();
      expect(json.error.code).toBe("METHOD_NOT_ALLOWED");
    });
  });

  describe("Zod validation pipeline", () => {
    const bodySchema = z.object({
      amount: z.string().min(1),
      assetCode: z.string().max(12),
    });

    const querySchema = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().optional(),
    });

    it("validates request body and provides typed body to handler", async () => {
      const handler = apiHandler(
        {
          name: "POST /api/payments",
          schema: { body: bodySchema },
        },
        async ({ body }) => {
          return successResponse({ receivedAmount: body.amount });
        }
      );

      const req = new Request("http://localhost/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: "100.50", assetCode: "USDC" }),
      });

      const res = await handler(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.receivedAmount).toBe("100.50");
    });

    it("returns 400 VALIDATION_ERROR when body violates schema", async () => {
      const handler = apiHandler(
        {
          name: "POST /api/payments",
          schema: { body: bodySchema },
        },
        async () => successResponse({ ok: true })
      );

      const req = new Request("http://localhost/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: "" }), // missing assetCode, empty amount
      });

      const res = await handler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(Array.isArray(json.error.details)).toBe(true);
    });

    it("returns 400 BAD_REQUEST on invalid JSON syntax", async () => {
      const handler = apiHandler(
        {
          name: "POST /api/payments",
          schema: { body: bodySchema },
        },
        async () => successResponse({ ok: true })
      );

      const req = new Request("http://localhost/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ malformed json",
      });

      const res = await handler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe(ERROR_CODES.BAD_REQUEST);
      expect(json.error.message).toContain("Invalid JSON body");
    });

    it("validates and coerces query parameters with schema defaults", async () => {
      const handler = apiHandler(
        {
          name: "GET /api/payments",
          schema: { query: querySchema },
        },
        async ({ query }) => {
          return successResponse({ limit: query.limit, search: query.search });
        }
      );

      // No query params provided -> uses default(20)
      const res1 = await handler(new Request("http://localhost/api/payments"));
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.data.limit).toBe(20);

      // Explicit query params coerced from string
      const res2 = await handler(
        new Request("http://localhost/api/payments?limit=50&search=stellar")
      );
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.data.limit).toBe(50);
      expect(json2.data.search).toBe("stellar");
    });

    it("returns 400 VALIDATION_ERROR on invalid query params", async () => {
      const handler = apiHandler(
        {
          name: "GET /api/payments",
          schema: { query: querySchema },
        },
        async () => successResponse({ ok: true })
      );

      // limit exceeds max(100)
      const res = await handler(
        new Request("http://localhost/api/payments?limit=999")
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it("validates dynamic route params including Promise params", async () => {
      const paramsSchema = z.object({
        id: z.string().uuid(),
      });

      const handler = apiHandler(
        {
          name: "GET /api/payments/[id]",
          schema: { params: paramsSchema },
        },
        async ({ params }) => {
          return successResponse({ id: params.id });
        }
      );

      // Next.js 15 Promise params test
      const validId = "123e4567-e89b-12d3-a456-426614174000";
      const resValid = await handler(
        new Request(`http://localhost/api/payments/${validId}`),
        { params: Promise.resolve({ id: validId }) }
      );
      expect(resValid.status).toBe(200);
      const jsonValid = await resValid.json();
      expect(jsonValid.data.id).toBe(validId);

      // Invalid UUID param
      const resInvalid = await handler(
        new Request("http://localhost/api/payments/invalid-id"),
        { params: { id: "not-a-uuid" } }
      );
      expect(resInvalid.status).toBe(400);
      const jsonInvalid = await resInvalid.json();
      expect(jsonInvalid.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });
  });

  describe("Rate limiting integration", () => {
    it("returns 429 when custom route rate limit is exceeded", async () => {
      mockedGetRateLimitStore.mockReturnValue({
        increment: vi.fn().mockResolvedValue({
          allowed: false,
          remaining: 0,
          resetAt: Date.now() + 30_000,
        }),
      } as unknown as ReturnType<typeof getRateLimitStore>);


      const handler = apiHandler(
        {
          name: "POST /api/expensive",
          rateLimit: { max: 5, windowMs: 60_000 },
        },
        async () => successResponse({ ok: true })
      );

      const res = await handler(
        new Request("http://localhost/api/expensive", { method: "POST" })
      );
      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json.error.code).toBe(ERROR_CODES.RATE_LIMITED);
      expect(res.headers.get("Retry-After")).toBeDefined();
    });
  });

  describe("Error mapping", () => {
    it("catches unhandled exceptions and maps them via handleApiError", async () => {
      const handler = apiHandler({ name: "GET /api/fails" }, async () => {
        throw new Error("Database timeout connection lost");
      });

      const res = await handler(new Request("http://localhost/api/fails"));
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    });
  });

  describe("Alias withApiHandler", () => {
    it("functions identically to apiHandler", async () => {
      const handler = withApiHandler({ name: "GET /api/test" }, async ({ auth }) => {
        return successResponse({ id: auth.userId });
      });

      const res = await handler(new Request("http://localhost/api/test"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.id).toBe("usr_test123");
    });
  });
});

describe("Composable helper functions", () => {
  describe("withAuth", () => {
    it("authenticates and passes auth context to inner handler", async () => {
      const handler = withAuth(async (req, auth) => {
        return successResponse({ user: auth.userId });
      });

      const res = await handler(new Request("http://localhost/api/comp-auth"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.user).toBe("usr_test123");
    });

    it("rejects unauthenticated requests with 401", async () => {
      mockedGetAuth.mockResolvedValue(null);

      const handler = withAuth(async () => successResponse({ ok: true }));
      const res = await handler(new Request("http://localhost/api/comp-auth"));
      expect(res.status).toBe(401);
    });
  });

  describe("withValidation", () => {
    it("validates body and query standalone", async () => {
      const schema = {
        body: z.object({ title: z.string().min(1) }),
        query: z.object({ sort: z.enum(["asc", "desc"]).default("asc") }),
      };

      const handler = withValidation(schema, async (req, { body, query }) => {
        return successResponse({ title: body.title, sort: query.sort });
      });

      const req = new Request("http://localhost/api/validate?sort=desc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Hello" }),
      });

      const res = await handler(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.title).toBe("Hello");
      expect(json.data.sort).toBe("desc");
    });
  });

  describe("withMutatingRoute", () => {
    it("enforces CSRF and wraps with error handling", async () => {
      const handler = withMutatingRoute(async () => {
        return successResponse({ mutated: true });
      });

      const res = await handler(
        new Request("http://localhost/api/mutate", { method: "POST" })
      );
      expect(res.status).toBe(200);
      expect(mockedVerifyCsrf).toHaveBeenCalledTimes(1);
    });
  });

  describe("extractQueryParams utility", () => {
    it("correctly groups single and multi-value query parameters", () => {
      const url = "http://localhost/api?foo=1&bar=a&bar=b&empty=";
      const parsed = extractQueryParams(url);
      expect(parsed.foo).toBe("1");
      expect(parsed.bar).toEqual(["a", "b"]);
      expect(parsed.empty).toBe("");
    });
  });
});
