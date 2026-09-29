// SPDX-License-Identifier: MIT

import { z } from "zod";
import { getAuthContext, type AuthContext } from "@/lib/auth-session";
import { requireScopes, type ApiScope } from "@/lib/api-auth";
import { verifyCsrf } from "@/lib/csrf";
import {
  validationError,
  unauthorizedError,
  badRequestError,
  methodNotAllowedError,
  rateLimitError,
  handleApiError,
} from "@/lib/api-response";
import { withRequestLogging, getCurrentRequestId } from "@/lib/request-logging";
import { recordEndpointLatency } from "@/lib/metrics-counters";
import { getRateLimitStore } from "@/lib/rate-limit";

// ── Types ────────────────────────────────────────────────────────

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface AuthOptOut {
  required: false;
  reason?: string;
  public?: boolean;
}

export interface AuthPublic {
  public: true;
  reason?: string;
}

export interface AuthScopesConfig {
  required?: true;
  scopes: ApiScope | ApiScope[];
}

export interface AuthRequiredConfig {
  required: true;
}

export type AuthConfig =
  | boolean
  | AuthOptOut
  | AuthPublic
  | AuthScopesConfig
  | AuthRequiredConfig;

export interface HandlerAuthContext extends AuthContext {
  scopes?: string[];
}


export type ResolvedAuth<TAuth> = TAuth extends false | AuthOptOut | AuthPublic
  ? HandlerAuthContext | null
  : HandlerAuthContext;


export type CsrfConfig =
  | boolean
  | {
      exempt: true;
      reason: string;
    };

export interface ValidationSchemas<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
> {
  body?: z.ZodType<TBody>;
  query?: z.ZodType<TQuery>;
  params?: z.ZodType<TParams>;
}

export interface ApiHandlerContext<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
  TAuth extends AuthConfig = true,
> {
  request: Request;
  auth: ResolvedAuth<TAuth>;
  body: TBody;
  query: TQuery;
  params: TParams;
  requestId?: string;
}

export interface ApiRouteConfig<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
  TAuth extends AuthConfig = true,
> {
  /** Optional endpoint label for metrics and logs (e.g. "POST /api/payments"). */
  name?: string;
  /** Permitted HTTP method(s). Requests with other methods receive 405. */
  method?: HttpMethod | HttpMethod[];
  /**
   * Authentication requirement.
   * Defaults to `true` (authentication required via wallet session or API key).
   * To opt out, explicitly pass `auth: false` or `{ public: true, reason: "..." }`.
   */
  auth?: TAuth;
  /**
   * CSRF protection configuration.
   * Defaults to enforced for mutating methods (POST, PUT, PATCH, DELETE).
   * To opt out on machine-invoked mutating routes, explicitly pass
   * `{ exempt: true, reason: "..." }` or `false`.
   */
  csrf?: CsrfConfig;
  /** Zod schemas for request payload validation. */
  schema?: ValidationSchemas<TBody, TQuery, TParams>;
  /** Optional route-level stricter rate limiting. */
  rateLimit?: {
    key?: (ctx: ApiHandlerContext<TBody, TQuery, TParams, TAuth>) => string;
    windowMs?: number;
    max?: number;
  };
  /** Whether to record endpoint latency metrics (default: true). */
  metrics?: boolean;
  /** Whether to wrap in structured request logging (default: true). */
  logging?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Extract query parameters from URL into an object suitable for Zod validation.
 * Multi-value parameters become arrays of strings; single-value are strings.
 */
export function extractQueryParams(url: string): Record<string, unknown> {
  const { searchParams } = new URL(url);
  const result: Record<string, unknown> = {};
  for (const [key, value] of searchParams.entries()) {
    if (key in result) {
      const existing = result[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result[key] = [existing, value];
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Safely parse JSON request body if present. */
async function parseRequestBody(
  request: Request
): Promise<{ ok: true; data: unknown } | { ok: false; errorResponse: Response }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength === "0") {
    return { ok: true, data: undefined };
  }

  try {
    const text = await request.clone().text();
    if (!text || text.trim().length === 0) {
      return { ok: true, data: undefined };
    }
    const json = JSON.parse(text);
    return { ok: true, data: json };
  } catch {
    return {
      ok: false,
      errorResponse: badRequestError("Invalid JSON body"),
    };
  }
}

/** Resolve dynamic route params from Next.js context argument. */
async function resolveRouteParams(context?: unknown): Promise<Record<string, unknown>> {
  if (context && typeof context === "object" && "params" in context) {
    const raw = (context as { params: unknown }).params;
    if (raw instanceof Promise || (raw && typeof raw === "object" && "then" in raw)) {
      return (await raw) as Record<string, unknown>;
    }
    if (raw && typeof raw === "object") {
      return raw as Record<string, unknown>;
    }
  }
  return {};
}

/** Resolve and enforce authentication based on configuration. */
async function resolveAuth(
  request: Request,
  authConfig?: AuthConfig
): Promise<{ ok: true; auth: HandlerAuthContext | null } | { ok: false; response: Response }> {

  const isRequired =
    authConfig === undefined ||
    authConfig === true ||
    (typeof authConfig === "object" &&
      !("required" in authConfig && authConfig.required === false) &&
      !("public" in authConfig && authConfig.public === true));

  // Check if scopes required
  const requiredScopes =
    typeof authConfig === "object" && "scopes" in authConfig && authConfig.scopes
      ? authConfig.scopes
      : undefined;

  if (requiredScopes) {
    const authResult = await requireScopes(request, requiredScopes);
    if (!("userId" in authResult)) {
      return { ok: false, response: authResult };
    }
    return {
      ok: true,
      auth: {
        userId: authResult.userId,
        keyId: authResult.keyId,
        scopes: authResult.scopes,
      },
    };
  }

  const auth = await getAuthContext(request);
  if (!auth && isRequired) {
    return {
      ok: false,
      response: unauthorizedError(
        "Authentication required. Connect your wallet or provide an API key."
      ),
    };
  }

  return { ok: true, auth };
}

/** Verify CSRF if method is mutating and route has not explicitly opted out. */
function checkCsrf(
  request: Request,
  method: string,
  csrfConfig?: CsrfConfig
): Response | null {
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
  if (!isMutating) return null;

  // Explicit opt-out
  if (csrfConfig === false) return null;
  if (typeof csrfConfig === "object" && csrfConfig.exempt) return null;

  return verifyCsrf(request);
}

// ── Main Route Wrapper ───────────────────────────────────────────

/**
 * Unified, composable API route wrapper that encodes the canonical security pipeline:
 *
 * 1. Request logging & request-id tracking (withRequestLogging)
 * 2. Metrics latency and error recording (withMetrics)
 * 3. Method validation (405 if disallowed)
 * 4. CSRF verification for mutating methods (403 if invalid / missing)
 * 5. Authentication (401 if missing, 403 if scopes missing)
 * 6. Input validation for query, body, and route params via Zod (400 if invalid)
 * 7. Route-level rate limiting
 * 8. Centralized error handling via handleApiError
 *
 * Usage:
 * ```ts
 * export const POST = apiHandler({
 *   name: "POST /api/payments",
 *   schema: { body: createPaymentSchema },
 * }, async ({ auth, body }) => {
 *   // auth and body are fully typed and validated
 *   return successResponse(item, undefined, 201);
 * });
 * ```
 */
export function apiHandler<
  TBody = undefined,
  TQuery = undefined,
  TParams = undefined,
  TAuth extends AuthConfig = true,
>(
  config: ApiRouteConfig<TBody, TQuery, TParams, TAuth>,
  handler: (
    ctx: ApiHandlerContext<TBody, TQuery, TParams, TAuth>
  ) => Promise<Response> | Response
): (request: Request, context?: unknown) => Promise<Response> {
  const inner = async (
    request: Request,
    rawContext?: unknown
  ): Promise<Response> => {
    const method = request.method.toUpperCase();
    const url = new URL(request.url);
    const endpointLabel = config.name ?? `${method} ${url.pathname}`;
    const start = performance.now();
    let status = 0;

    try {
      // 1. Method verification
      if (config.method) {
        const allowed = Array.isArray(config.method)
          ? config.method.map((m) => m.toUpperCase())
          : [config.method.toUpperCase()];
        if (!allowed.includes(method as HttpMethod)) {
          const res = methodNotAllowedError(`Method ${method} not allowed`);
          status = res.status;
          return res;
        }
      }

      // 2. CSRF verification (checked before touching DB or parsing JSON body)
      const csrfErr = checkCsrf(request, method, config.csrf);
      if (csrfErr) {
        status = csrfErr.status;
        return csrfErr;
      }

      // 3. Authentication
      const authResult = await resolveAuth(request, config.auth);
      if (!authResult.ok) {
        status = authResult.response.status;
        return authResult.response;
      }
      const auth = authResult.auth as ResolvedAuth<TAuth>;

      // 4. Query validation
      let parsedQuery: unknown = undefined;
      const rawQuery = extractQueryParams(request.url);
      if (config.schema?.query) {
        const parsed = config.schema.query.safeParse(rawQuery);
        if (!parsed.success) {
          const res = validationError(parsed.error);
          status = res.status;
          return res;
        }
        parsedQuery = parsed.data;
      } else {
        parsedQuery = rawQuery;
      }

      // 5. Body validation
      let parsedBody: unknown = undefined;
      if (config.schema?.body) {
        const bodyParse = await parseRequestBody(request);
        if (!bodyParse.ok) {
          status = bodyParse.errorResponse.status;
          return bodyParse.errorResponse;
        }
        const parsed = config.schema.body.safeParse(bodyParse.data);
        if (!parsed.success) {
          const res = validationError(parsed.error);
          status = res.status;
          return res;
        }
        parsedBody = parsed.data;
      }

      // 6. Route params validation
      let parsedParams: unknown = undefined;
      const rawParams = await resolveRouteParams(rawContext);
      if (config.schema?.params) {
        const parsed = config.schema.params.safeParse(rawParams);
        if (!parsed.success) {
          const res = validationError(parsed.error);
          status = res.status;
          return res;
        }
        parsedParams = parsed.data;
      } else {
        parsedParams = rawParams;
      }

      // Construct typed Context
      const ctx: ApiHandlerContext<TBody, TQuery, TParams, TAuth> = {
        request,
        auth,
        body: parsedBody as TBody,
        query: parsedQuery as TQuery,
        params: parsedParams as TParams,
        requestId: getCurrentRequestId(),
      };

      // 7. Route-level rate limiting
      if (config.rateLimit) {
        const key = config.rateLimit.key
          ? config.rateLimit.key(ctx)
          : `route:${endpointLabel}:${auth?.userId ?? "anon"}`;
        const store = getRateLimitStore();
        const limitResult = await store.increment(
          key,
          config.rateLimit.windowMs ?? 60_000,
          config.rateLimit.max ?? 60
        );
        if (!limitResult.allowed) {
          const retryAfter = Math.max(
            1,
            Math.ceil((limitResult.resetAt - Date.now()) / 1000)
          );
          const res = rateLimitError("Too many requests", retryAfter);
          status = res.status;
          return res;
        }
      }

      // 8. Execute inner handler
      const response = await handler(ctx);
      status = response.status;
      return response;
    } catch (err) {
      status = 500;
      return handleApiError(err, endpointLabel);
    } finally {
      if (config.metrics !== false) {
        const durationSec = (performance.now() - start) / 1000;
        const spaceIdx = endpointLabel.indexOf(" ");
        const m = spaceIdx === -1 ? method : endpointLabel.slice(0, spaceIdx);
        const ep = spaceIdx === -1 ? url.pathname : endpointLabel.slice(spaceIdx + 1);
        recordEndpointLatency(m, ep, status || 500, durationSec);
      }
    }
  };

  return config.logging !== false ? withRequestLogging(inner) : inner;
}

/** Alias for `apiHandler`. */
export const withApiHandler = apiHandler;

// ── Composable Building Blocks ───────────────────────────────────

/**
 * Composable auth middleware wrapper:
 * Enforces wallet session or API key authentication (and optional scopes).
 * Passes authenticated context to handler; returns 401/403 on missing or unauthorized credentials.
 */
export function withAuth<TContext = unknown>(
  handler: (
    request: Request,
    auth: HandlerAuthContext,
    context?: TContext
  ) => Promise<Response> | Response,
  options?: { scopes?: ApiScope | ApiScope[] }
): (request: Request, context?: TContext) => Promise<Response> {
  return async (request: Request, context?: TContext): Promise<Response> => {
    const authResult = await resolveAuth(
      request,
      options?.scopes ? { scopes: options.scopes } : true
    );
    if (!authResult.ok) {
      return authResult.response;
    }
    return handler(request, authResult.auth!, context);
  };
}


/**
 * Composable Zod input validation middleware:
 * Validates query parameters, body, and route params.
 * Returns 400 validation error response on failure.
 */
export function withValidation<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
  TContext = unknown,
>(
  schemas: ValidationSchemas<TBody, TQuery, TParams>,
  handler: (
    request: Request,
    data: { body: TBody; query: TQuery; params: TParams },
    context?: TContext
  ) => Promise<Response> | Response
): (request: Request, context?: TContext) => Promise<Response> {
  return async (request: Request, context?: TContext): Promise<Response> => {
    let parsedQuery: unknown = undefined;
    if (schemas.query) {
      const q = extractQueryParams(request.url);
      const parsed = schemas.query.safeParse(q);
      if (!parsed.success) return validationError(parsed.error);
      parsedQuery = parsed.data;
    }

    let parsedBody: unknown = undefined;
    if (schemas.body) {
      const bodyResult = await parseRequestBody(request);
      if (!bodyResult.ok) return bodyResult.errorResponse;
      const parsed = schemas.body.safeParse(bodyResult.data);
      if (!parsed.success) return validationError(parsed.error);
      parsedBody = parsed.data;
    }

    let parsedParams: unknown = undefined;
    if (schemas.params) {
      const p = await resolveRouteParams(context);
      const parsed = schemas.params.safeParse(p);
      if (!parsed.success) return validationError(parsed.error);
      parsedParams = parsed.data;
    }

    return handler(
      request,
      {
        body: parsedBody as TBody,
        query: parsedQuery as TQuery,
        params: parsedParams as TParams,
      },
      context
    );
  };
}

/**
 * Composable mutating route wrapper:
 * Enforces CSRF for mutating requests (unless opted out) and wraps with error handling and request logging.
 */
export function withMutatingRoute<TContext = unknown>(
  handler: (request: Request, context?: TContext) => Promise<Response> | Response,
  options?: { name?: string; csrf?: CsrfConfig }
): (request: Request, context?: TContext) => Promise<Response> {
  return withRequestLogging(async (request: Request, context?: TContext): Promise<Response> => {
    const method = request.method.toUpperCase();
    const label = options?.name ?? `${method} ${new URL(request.url).pathname}`;
    try {
      const csrfErr = checkCsrf(request, method, options?.csrf);
      if (csrfErr) return csrfErr;
      return await handler(request, context);
    } catch (err) {
      return handleApiError(err, label);
    }
  });
}
