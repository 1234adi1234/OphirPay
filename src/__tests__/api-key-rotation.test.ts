// SPDX-License-Identifier: MIT
/**
 * @vitest-environment node
 *
 * Issue #805: Zero-Downtime API Key Rotation Alongside Revocation.
 *
 * Comprehensive tests covering:
 *   1. Rotation key generation, identical scopes preservation, and parent/child relationship.
 *   2. Dual authentication during the configurable overlap window.
 *   3. Expiry after overlap window: rejection of old key with surfaced rotation reason.
 *   4. Explicit confirmation: immediate cutover and expiry of old key.
 *   5. Explicit cancellation: rollback of rotation, revoking replacement and restoring original key.
 *   6. API route endpoints (/api/keys/rotate, confirm, cancel, and GET /api/keys).
 *   7. Audit logging for rotate, confirm, cancel, and revoke lifecycle events.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
const mocks = vi.hoisted(() => ({
  apiKeyFindFirst: vi.fn(),
  apiKeyFindUnique: vi.fn(),
  apiKeyFindMany: vi.fn(),
  apiKeyCreate: vi.fn(),
  apiKeyUpdate: vi.fn(),
  apiKeyUpdateMany: vi.fn(),
  apiKeyDelete: vi.fn(),
  apiKeyDeleteMany: vi.fn(),
  apiKeyTransaction: vi.fn(),
  auditLogCreate: vi.fn(),
  logCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    apiKey: {
      findFirst: mocks.apiKeyFindFirst,
      findUnique: mocks.apiKeyFindUnique,
      findMany: mocks.apiKeyFindMany,
      create: mocks.apiKeyCreate,
      update: mocks.apiKeyUpdate,
      updateMany: mocks.apiKeyUpdateMany,
      delete: mocks.apiKeyDelete,
      deleteMany: mocks.apiKeyDeleteMany,
    },
    apiKeyRequestLog: {
      create: mocks.logCreate,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
    $transaction: mocks.apiKeyTransaction,
  },
}));

vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>();
  return {
    ...actual,
    getAuthContext: vi.fn(),
  };
});

vi.mock("@/lib/csrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/csrf")>();
  return {
    ...actual,
    verifyCsrf: vi.fn().mockReturnValue(null),
  };
});

vi.mock("@/lib/api-cache", () => ({
  invalidateCache: vi.fn().mockResolvedValue(undefined),
  invalidateCaches: vi.fn().mockResolvedValue(undefined),
  cachedRead: vi.fn(),
  readCacheKey: vi.fn(),
  resetReadCache: vi.fn(),
}));

import * as authSession from "@/lib/auth-session";
import * as csrf from "@/lib/csrf";
import {
  authenticateRequest,
  authenticateRequestDetailed,
  requireAuth,
  withApiAuth,
  requireScopes,
  generateApiKey,
  hashApiKeyV1,
  deriveKeyPrefix,
  API_KEY_PATTERN,
  DEFAULT_ROTATION_OVERLAP_HOURS,
  DEFAULT_ROTATION_OVERLAP_MS,
} from "@/lib/api-auth";
import {
  rotateApiKey,
  confirmApiKeyRotation,
  cancelApiKeyRotation,
  parseOverlapWindowMs,
  getApiKeyRotationStatus,
} from "@/lib/api-key-rotation";
import { AUDIT_ACTIONS } from "@/lib/audit";
import { POST as postRotate } from "@/app/api/keys/rotate/route";
import { POST as postConfirm } from "@/app/api/keys/rotate/confirm/route";
import { POST as postCancel } from "@/app/api/keys/rotate/cancel/route";
import { GET as getKeys, DELETE as deleteKeys } from "@/app/api/keys/route";

const USER_ID = "usr_institutional_001";
const OLD_KEY_ID = "key_parent_123";
const NEW_KEY_ID = "key_replacement_456";
const TEST_SCOPES = ["read:payments", "write:payments", "read:analytics"];

function makeStoredKey(overrides: Record<string, unknown> = {}) {
  const rawKey = generateApiKey();
  return {
    id: OLD_KEY_ID,
    userId: USER_ID,
    name: "Production Invoicing Bot",
    keyHash: hashApiKeyV1(rawKey),
    prefix: deriveKeyPrefix(rawKey),
    scopes: TEST_SCOPES,
    lastUsed: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    expiresAt: null,
    rotatedAt: null,
    rotatedFromId: null,
    preRotationExpiresAt: null,
    ...overrides,
  };
}

describe("Issue #805: API Key Rotation & Overlap Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(csrf.verifyCsrf).mockReturnValue(null);
    mocks.apiKeyUpdate.mockImplementation(({ where, data }) =>
      Promise.resolve({ id: where?.id ?? OLD_KEY_ID, ...data })
    );
    mocks.apiKeyCreate.mockImplementation(({ data }) => Promise.resolve({ id: NEW_KEY_ID, ...data }));
    mocks.auditLogCreate.mockResolvedValue({ id: "audit_1" });
    mocks.logCreate.mockResolvedValue({});
    mocks.apiKeyTransaction.mockImplementation(async (fns: Promise<unknown>[]) => {
      return Promise.all(fns);
    });
  });

  describe("1. parseOverlapWindowMs helper", () => {
    it("defaults to 24 hours (86,400,000 ms)", () => {
      expect(DEFAULT_ROTATION_OVERLAP_HOURS).toBe(24);
      expect(parseOverlapWindowMs({})).toBe(24 * 60 * 60 * 1000);
      expect(parseOverlapWindowMs({})).toBe(DEFAULT_ROTATION_OVERLAP_MS);
    });

    it("respects overlapSeconds for high-precision testing", () => {
      expect(parseOverlapWindowMs({ overlapSeconds: 120 })).toBe(120_000);
    });

    it("respects overlapHours", () => {
      expect(parseOverlapWindowMs({ overlapHours: 48 })).toBe(48 * 60 * 60 * 1000);
      expect(parseOverlapWindowMs({ overlapHours: 1 })).toBe(3600_000);
    });

    it("parses overlapWindow string formats (1h, 24h, 7d, 30m, 60s)", () => {
      expect(parseOverlapWindowMs({ overlapWindow: "1h" })).toBe(3600_000);
      expect(parseOverlapWindowMs({ overlapWindow: "24h" })).toBe(86_400_000);
      expect(parseOverlapWindowMs({ overlapWindow: "7d" })).toBe(7 * 24 * 3600_000);
      expect(parseOverlapWindowMs({ overlapWindow: "30m" })).toBe(30 * 60_000);
      expect(parseOverlapWindowMs({ overlapWindow: "90s" })).toBe(90_000);
    });
  });

  describe("2. getApiKeyRotationStatus helper", () => {
    it("identifies active keys", () => {
      expect(getApiKeyRotationStatus({ expiresAt: null, rotatedAt: null })).toBe("active");
      expect(
        getApiKeyRotationStatus({
          expiresAt: new Date(Date.now() + 100_000),
          rotatedAt: null,
        })
      ).toBe("active");
    });

    it("identifies keys currently in rotation overlap window", () => {
      expect(
        getApiKeyRotationStatus({
          expiresAt: new Date(Date.now() + 50_000),
          rotatedAt: new Date(),
        })
      ).toBe("rotating");
    });

    it("identifies keys that expired after rotation", () => {
      expect(
        getApiKeyRotationStatus({
          expiresAt: new Date(Date.now() - 1000),
          rotatedAt: new Date(Date.now() - 86400_000),
        })
      ).toBe("rotated_expired");
    });

    it("identifies standard expired keys", () => {
      expect(
        getApiKeyRotationStatus({
          expiresAt: new Date(Date.now() - 1000),
          rotatedAt: null,
        })
      ).toBe("expired");
    });
  });

  describe("3. Core Service: rotateApiKey", () => {
    it("produces a new key with identical scopes and records parent-child relationship", async () => {
      const oldKey = makeStoredKey({ scopes: ["read:payments", "write:payments"] });
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldKey);

      const result = await rotateApiKey(USER_ID, {
        id: OLD_KEY_ID,
        overlapHours: 12,
      });

      // Key format must conform to OphirPay 32 CSPRNG bytes format (oph_ + 64 hex chars)
      expect(result.newKey.key).toMatch(API_KEY_PATTERN);
      expect(result.newKey.prefix).toBe(result.newKey.key.slice(0, 8));
      expect(result.newKey.scopes).toEqual(["read:payments", "write:payments"]);
      expect(result.newKey.rotatedFromId).toBe(OLD_KEY_ID);

      // Overlap expiry should be ~12 hours from now
      const now = Date.now();
      const expectedOverlapMs = 12 * 60 * 60 * 1000;
      expect(result.overlapWindowMs).toBe(expectedOverlapMs);
      expect(result.overlapExpiresAt.getTime()).toBeGreaterThanOrEqual(now + expectedOverlapMs - 2000);
      expect(result.overlapExpiresAt.getTime()).toBeLessThanOrEqual(now + expectedOverlapMs + 2000);

      // Transaction verification
      expect(mocks.apiKeyTransaction).toHaveBeenCalledTimes(1);

      // Audit trail must be recorded
      expect(mocks.auditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AUDIT_ACTIONS.API_KEY_ROTATE,
            actor: USER_ID,
            target: OLD_KEY_ID,
            details: expect.objectContaining({
              oldKeyId: OLD_KEY_ID,
              scopes: ["read:payments", "write:payments"],
              overlapHours: 12,
            }),
          }),
        })
      );
    });

    it("does not extend expiration beyond pre-existing expiresAt on old key", async () => {
      // Old key expires in 2 hours
      const preExistingExpiry = new Date(Date.now() + 2 * 3600_000);
      const oldKey = makeStoredKey({ expiresAt: preExistingExpiry });
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldKey);

      // Requesting 24 hours overlap
      const result = await rotateApiKey(USER_ID, {
        id: OLD_KEY_ID,
        overlapHours: 24,
      });

      // Must be capped by the old key's existing expiry (2 hours), not 24 hours
      expect(result.overlapExpiresAt.getTime()).toBe(preExistingExpiry.getTime());
    });

    it("rejects rotating a non-existent or unowned key", async () => {
      mocks.apiKeyFindFirst.mockResolvedValueOnce(null);
      await expect(rotateApiKey(USER_ID, { id: "non_existent" })).rejects.toThrow(
        "Key not found"
      );
    });

    it("rejects rotating an already expired key", async () => {
      mocks.apiKeyFindFirst.mockResolvedValueOnce(
        makeStoredKey({ expiresAt: new Date(Date.now() - 5000) })
      );
      await expect(rotateApiKey(USER_ID, { id: OLD_KEY_ID })).rejects.toThrow(
        "Cannot rotate an expired key"
      );
    });

    it("rejects rotating a key already undergoing active rotation", async () => {
      mocks.apiKeyFindFirst.mockResolvedValueOnce(
        makeStoredKey({
          rotatedAt: new Date(),
          expiresAt: new Date(Date.now() + 3600_000),
        })
      );
      await expect(rotateApiKey(USER_ID, { id: OLD_KEY_ID })).rejects.toThrow(
        /already undergoing rotation/
      );
    });
  });

  describe("4. Dual Authentication during Overlap Window", () => {
    it("authenticates BOTH old key and new key successfully during the overlap window", async () => {
      const rawOldKey = generateApiKey();
      const rawNewKey = generateApiKey();

      const overlapFuture = new Date(Date.now() + 3600_000); // 1h in future

      const oldKeyRecord = {
        id: OLD_KEY_ID,
        userId: USER_ID,
        name: "Old Parent Key",
        keyHash: hashApiKeyV1(rawOldKey),
        prefix: deriveKeyPrefix(rawOldKey),
        scopes: ["read:payments"],
        expiresAt: overlapFuture,
        rotatedAt: new Date(),
      };

      const newKeyRecord = {
        id: NEW_KEY_ID,
        userId: USER_ID,
        name: "New Replacement Key",
        keyHash: hashApiKeyV1(rawNewKey),
        prefix: deriveKeyPrefix(rawNewKey),
        scopes: ["read:payments"],
        expiresAt: null,
        rotatedFromId: OLD_KEY_ID,
      };

      // 1. Authenticate with old key
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldKeyRecord);
      const reqOld = new Request("http://localhost/api/test", {
        headers: { "x-api-key": rawOldKey },
      });
      const authOld = await authenticateRequest(reqOld);
      expect(authOld).not.toBeNull();
      expect(authOld?.keyId).toBe(OLD_KEY_ID);
      expect(authOld?.scopes).toEqual(["read:payments"]);

      // 2. Authenticate with new key
      mocks.apiKeyFindFirst.mockResolvedValueOnce(newKeyRecord);
      const reqNew = new Request("http://localhost/api/test", {
        headers: { "x-api-key": rawNewKey },
      });
      const authNew = await authenticateRequest(reqNew);
      expect(authNew).not.toBeNull();
      expect(authNew?.keyId).toBe(NEW_KEY_ID);
      expect(authNew?.scopes).toEqual(["read:payments"]);
    });
  });

  describe("5. Expiry after Overlap Window: Old Key Rejection & Reason Surfacing", () => {
    it("rejects old key after window closes with clear rotation expiry reason", async () => {
      const rawOldKey = generateApiKey();
      const rawNewKey = generateApiKey();

      const expiredPast = new Date(Date.now() - 10_000); // 10s ago

      const oldExpiredKey = {
        id: OLD_KEY_ID,
        userId: USER_ID,
        name: "Old Rotated Key",
        keyHash: hashApiKeyV1(rawOldKey),
        prefix: deriveKeyPrefix(rawOldKey),
        scopes: ["read:payments"],
        expiresAt: expiredPast,
        rotatedAt: new Date(Date.now() - 86400_000),
      };

      const activeNewKey = {
        id: NEW_KEY_ID,
        userId: USER_ID,
        name: "New Replacement Key",
        keyHash: hashApiKeyV1(rawNewKey),
        prefix: deriveKeyPrefix(rawNewKey),
        scopes: ["read:payments"],
        expiresAt: null,
      };

      // Authenticate with old expired key
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldExpiredKey);
      const reqOld = new Request("http://localhost/api/test", {
        headers: { "x-api-key": rawOldKey },
      });

      // authenticateRequest returns null (fail closed)
      const authOld = await authenticateRequest(reqOld);
      expect(authOld).toBeNull();

      // authenticateRequestDetailed surfaces specific rejection reason and message
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldExpiredKey);
      const detailedOld = await authenticateRequestDetailed(reqOld);
      expect(detailedOld.authenticated).toBe(false);
      expect(detailedOld.reason).toBe("key_rotated_expired");
      expect(detailedOld.message).toContain("API key has expired following rotation");

      // withApiAuth returns 401 with the rotation expiry reason in response body
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldExpiredKey);
      const handler = vi.fn();
      const protectedHandler = withApiAuth(handler);
      const response = await protectedHandler(reqOld);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.message).toContain("API key has expired following rotation");
      expect(handler).not.toHaveBeenCalled();

      // requireAuth returns 401 with rotation expiry reason
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldExpiredKey);
      const authResult = await requireAuth(reqOld);
      expect("userId" in authResult).toBe(false);
      if (!("userId" in authResult)) {
        expect(authResult.status).toBe(401);
        const authBody = await authResult.json();
        expect(authBody.error.message).toContain("API key has expired following rotation");
      }

      // requireScopes returns 401 with rotation expiry reason
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldExpiredKey);
      const scopeResult = await requireScopes(reqOld, "read:payments");
      expect("userId" in scopeResult).toBe(false);
      if (!("userId" in scopeResult)) {
        expect(scopeResult.status).toBe(401);
        const scopeBody = await scopeResult.json();
        expect(scopeBody.error.message).toContain("API key has expired following rotation");
      }

      // New key continues to authenticate without interruption
      mocks.apiKeyFindFirst.mockResolvedValueOnce(activeNewKey);
      const reqNew = new Request("http://localhost/api/test", {
        headers: { "x-api-key": rawNewKey },
      });
      const authNew = await authenticateRequest(reqNew);
      expect(authNew?.keyId).toBe(NEW_KEY_ID);
    });
  });

  describe("6. Explicit Confirmation (Early Cutover)", () => {
    it("expires the old key immediately and logs rotation confirmation in audit log", async () => {
      const oldKey = {
        id: OLD_KEY_ID,
        userId: USER_ID,
        rotatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400_000),
        rotations: [{ id: NEW_KEY_ID, name: "New Key", prefix: "oph_new1" }],
        rotatedFrom: null,
      };
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldKey);

      const result = await confirmApiKeyRotation(USER_ID, OLD_KEY_ID);

      expect(result.confirmed).toBe(true);
      expect(result.expiredKeyId).toBe(OLD_KEY_ID);
      expect(result.replacementKeyId).toBe(NEW_KEY_ID);

      // Verify old key expiration updated to immediate past
      expect(mocks.apiKeyUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: OLD_KEY_ID },
          data: expect.objectContaining({
            expiresAt: expect.any(Date),
          }),
        })
      );
      const updateCall = mocks.apiKeyUpdate.mock.calls[0]![0];
      expect(updateCall.data.expiresAt.getTime()).toBeLessThan(Date.now());

      // Verify audit log recorded
      expect(mocks.auditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AUDIT_ACTIONS.API_KEY_ROTATE_CONFIRM,
            actor: USER_ID,
            target: OLD_KEY_ID,
          }),
        })
      );
    });

    it("can be confirmed by referencing the replacement key ID", async () => {
      const replacementKey = {
        id: NEW_KEY_ID,
        userId: USER_ID,
        rotatedAt: null,
        rotatedFromId: OLD_KEY_ID,
        rotations: [],
        rotatedFrom: { id: OLD_KEY_ID, name: "Old Parent Key" },
      };
      mocks.apiKeyFindFirst.mockResolvedValueOnce(replacementKey);

      const result = await confirmApiKeyRotation(USER_ID, NEW_KEY_ID);
      expect(result.confirmed).toBe(true);
      expect(result.expiredKeyId).toBe(OLD_KEY_ID);
    });
  });

  describe("7. Explicit Cancellation (Rollback)", () => {
    it("cancels rotation: deletes replacement key, restores pre-rotation expiration on old key", async () => {
      const originalExpiry = new Date("2026-12-31T23:59:59Z");
      const oldKeyWithRotation = {
        id: OLD_KEY_ID,
        userId: USER_ID,
        rotatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400_000), // overlap expiry
        preRotationExpiresAt: originalExpiry,
        rotations: [{ id: NEW_KEY_ID, name: "New Key", prefix: "oph_new1" }],
        rotatedFrom: null,
      };
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldKeyWithRotation);

      const result = await cancelApiKeyRotation(USER_ID, OLD_KEY_ID);

      expect(result.cancelled).toBe(true);
      expect(result.restoredKeyId).toBe(OLD_KEY_ID);
      expect(result.revokedKeyId).toBe(NEW_KEY_ID);

      // Verify replacement key is deleted in transaction
      expect(mocks.apiKeyTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.apiKeyDelete).toHaveBeenCalledWith({
        where: { id: NEW_KEY_ID },
      });

      // Verify old key restored to preRotationExpiresAt
      expect(mocks.apiKeyUpdate).toHaveBeenCalledWith({
        where: { id: OLD_KEY_ID },
        data: {
          rotatedAt: null,
          expiresAt: originalExpiry,
          preRotationExpiresAt: null,
        },
      });

      // Verify cancellation audit log recorded
      expect(mocks.auditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AUDIT_ACTIONS.API_KEY_ROTATE_CANCEL,
            actor: USER_ID,
            target: OLD_KEY_ID,
            details: expect.objectContaining({
              revokedKeyId: NEW_KEY_ID,
            }),
          }),
        })
      );
    });
  });

  describe("8. HTTP Route Handlers: /api/keys/rotate", () => {
    it("POST /api/keys/rotate returns 401 when unauthenticated", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce(null);
      const req = new Request("http://localhost/api/keys/rotate", {
        method: "POST",
        body: JSON.stringify({ id: OLD_KEY_ID }),
      });
      const res = await postRotate(req);
      expect(res.status).toBe(401);
    });

    it("POST /api/keys/rotate returns 400 when key ID is missing", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce({ userId: USER_ID });
      const req = new Request("http://localhost/api/keys/rotate", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const res = await postRotate(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.message).toContain("Key ID is required");
    });

    it("POST /api/keys/rotate returns 201 with new key and overlap details", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce({ userId: USER_ID });
      const oldKey = makeStoredKey();
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldKey);

      const req = new Request("http://localhost/api/keys/rotate", {
        method: "POST",
        body: JSON.stringify({ id: OLD_KEY_ID, overlapHours: 24 }),
      });
      const res = await postRotate(req);
      expect(res.status).toBe(201);
      const data = await res.json();

      expect(data.data.newKey.key).toMatch(API_KEY_PATTERN);
      expect(data.data.newKey.scopes).toEqual(oldKey.scopes);
      expect(data.data.newKey.rotatedFromId).toBe(OLD_KEY_ID);
      expect(data.data.oldKey.id).toBe(OLD_KEY_ID);
      expect(data.data.oldKey.status).toBe("rotating");
    });

    it("POST /api/keys/rotate with action='confirm' executes early cutover", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce({ userId: USER_ID });
      const oldKey = {
        id: OLD_KEY_ID,
        userId: USER_ID,
        rotatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400_000),
        rotations: [{ id: NEW_KEY_ID }],
        rotatedFrom: null,
      };
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldKey);

      const req = new Request("http://localhost/api/keys/rotate", {
        method: "POST",
        body: JSON.stringify({ id: OLD_KEY_ID, action: "confirm" }),
      });
      const res = await postRotate(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.confirmed).toBe(true);
    });

    it("POST /api/keys/rotate/confirm route handler executes confirmation", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce({ userId: USER_ID });
      const oldKey = {
        id: OLD_KEY_ID,
        userId: USER_ID,
        rotatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400_000),
        rotations: [{ id: NEW_KEY_ID }],
        rotatedFrom: null,
      };
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldKey);

      const req = new Request("http://localhost/api/keys/rotate/confirm", {
        method: "POST",
        body: JSON.stringify({ id: OLD_KEY_ID }),
      });
      const res = await postConfirm(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.confirmed).toBe(true);
    });

    it("POST /api/keys/rotate/cancel route handler executes cancellation", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce({ userId: USER_ID });
      const oldKey = {
        id: OLD_KEY_ID,
        userId: USER_ID,
        rotatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400_000),
        preRotationExpiresAt: null,
        rotations: [{ id: NEW_KEY_ID }],
        rotatedFrom: null,
      };
      mocks.apiKeyFindFirst.mockResolvedValueOnce(oldKey);

      const req = new Request("http://localhost/api/keys/rotate/cancel", {
        method: "POST",
        body: JSON.stringify({ id: OLD_KEY_ID }),
      });
      const res = await postCancel(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.cancelled).toBe(true);
    });

    it("GET /api/keys includes rotation metadata and relationships", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce({ userId: USER_ID });
      const mockKeys = [
        {
          id: OLD_KEY_ID,
          name: "Old Key",
          prefix: "oph_old1",
          scopes: ["read:payments"],
          lastUsed: null,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 86400_000),
          rotatedAt: new Date(),
          rotatedFromId: null,
          rotatedFrom: null,
          rotations: [{ id: NEW_KEY_ID, name: "New Key", prefix: "oph_new1" }],
        },
      ];
      mocks.apiKeyFindMany.mockResolvedValueOnce(mockKeys);

      const res = await getKeys(new Request("http://localhost/api/keys"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data[0].rotatedAt).toBeDefined();
      expect(data.data[0].rotations).toHaveLength(1);
    });

    it("DELETE /api/keys unlinks child rotations and records audit log", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce({ userId: USER_ID });
      mocks.apiKeyUpdateMany.mockResolvedValueOnce({ count: 1 });
      mocks.apiKeyDeleteMany.mockResolvedValueOnce({ count: 1 });

      const res = await deleteKeys(
        new Request(`http://localhost/api/keys?id=${OLD_KEY_ID}`, { method: "DELETE" })
      );
      expect(res.status).toBe(200);
      expect(mocks.apiKeyUpdateMany).toHaveBeenCalledWith({
        where: { rotatedFromId: OLD_KEY_ID },
        data: { rotatedFromId: null },
      });
      expect(mocks.auditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "api_key:revoke",
            target: OLD_KEY_ID,
          }),
        })
      );
    });
  });
});
