// SPDX-License-Identifier: MIT

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

const { isSafeWebhookUrlAtDeliveryMock } = vi.hoisted(() => ({
  isSafeWebhookUrlAtDeliveryMock: vi.fn(),
}));

vi.mock("@/lib/webhook-url-guard", () => ({
  isSafeWebhookUrlAtDelivery: isSafeWebhookUrlAtDeliveryMock,
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    webhook: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    webhookDelivery: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthContext: vi.fn(),
}));

vi.mock("@/lib/csrf", () => ({
  verifyCsrf: vi.fn().mockReturnValue(null),
}));

import prisma from "@/lib/prisma";
import * as authSession from "@/lib/auth-session";
import { deliverWebhook, BLOCKED_WEBHOOK_TARGET_ERROR } from "@/lib/webhook-deliver";
import {
  persistDeliveryResult,
  bulkRedeliverDeadLetters,
  getDeadLetterDeliveries,
} from "@/lib/webhook-delivery-service";
import {
  incMetric,
  getMetricsSnapshot,
  resetMetricsForTest,
} from "@/lib/metrics-counters";
import { TimeoutError } from "@/lib/timeout";
import { GET as getDeliveries } from "@/app/api/webhooks/[id]/deliveries/route";
import {
  GET as getDeadLetterRoute,
  POST as postDeadLetterRoute,
} from "@/app/api/webhooks/[id]/deliveries/dead-letter/route";
import { GET as getDeliveryStats } from "@/app/api/webhooks/[id]/deliveries/stats/route";

const SECRET = "test-secret-key-1234567890";
const SAMPLE_PAYLOAD = {
  event: "payment.completed",
  timestamp: "2026-09-28T00:00:00.000Z",
  data: { paymentId: "pay_123", amount: "50.00", asset: "XLM" },
};

describe("Webhook Dead-Letter Queue & Delivery Timeout (#806)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetMetricsForTest();
    isSafeWebhookUrlAtDeliveryMock.mockReset();
    isSafeWebhookUrlAtDeliveryMock.mockResolvedValue(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Criterion 1: Per-attempt bounded timeout & failure reason ──

  describe("Per-attempt delivery timeout & distinct failure reasons", () => {
    it("enforces explicit per-attempt timeout and classifies failureReason as TIMEOUT", async () => {
      // Mock fetch rejecting with TimeoutError
      globalThis.fetch = vi.fn().mockRejectedValue(new TimeoutError(100, "Webhook delivery"));

      const result = await deliverWebhook(
        "https://example.com/webhook",
        SECRET,
        SAMPLE_PAYLOAD,
        { maxRetries: 1, timeoutMs: 100 }
      );

      expect(result.success).toBe(false);
      expect(result.failureReason).toBe("TIMEOUT");
      expect(result.errorMessage).toContain("Webhook delivery timed out after 100ms");
      expect(result.isDeadLettered).toBe(true);
      expect(result.attempts).toBe(1);

      const metrics = getMetricsSnapshot();
      expect(metrics.webhooks_failed_total).toBe(1);
      expect(metrics.webhooks_dead_letter_total).toBe(1);
      expect(metrics.delivery_final_outcomes).toContainEqual({
        delivery_type: "webhook",
        attempt_number: 1,
        final_outcome: "failure",
        count: 1,
      });
    });

    it("classifies HTTP non-2xx failure status as distinct failureReason", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue("Service Unavailable"),
      });

      const result = await deliverWebhook(
        "https://example.com/webhook",
        SECRET,
        SAMPLE_PAYLOAD,
        { maxRetries: 1 }
      );

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(503);
      expect(result.failureReason).toBe("HTTP_503");
      expect(result.errorMessage).toBe("HTTP 503");
      expect(result.responseBody).toBe("Service Unavailable");
      expect(result.isDeadLettered).toBe(true);
    });

    it("records BLOCKED_TARGET when SSRF guard blocks destination URL", async () => {
      isSafeWebhookUrlAtDeliveryMock.mockResolvedValue(false);

      const result = await deliverWebhook(
        "http://169.254.169.254/webhook",
        SECRET,
        SAMPLE_PAYLOAD,
        1
      );

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.failureReason).toBe("BLOCKED_TARGET");
      expect(result.errorMessage).toBe(BLOCKED_WEBHOOK_TARGET_ERROR);
      expect(result.isDeadLettered).toBe(true);
    });
  });

  // ── Criterion 2: Exhausted deliveries land in queryable dead-letter state ──

  describe("Exhausted retries move to dead-letter state with retained payload", () => {
    it("moves delivery to dead-letter state after retries are exhausted", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new TimeoutError(200, "Webhook delivery"));
        }
        return Promise.resolve({
          ok: false,
          status: 502,
          text: vi.fn().mockResolvedValue("Bad Gateway"),
        });
      });

      const result = await deliverWebhook(
        "https://example.com/webhook",
        SECRET,
        SAMPLE_PAYLOAD,
        { maxRetries: 2, timeoutMs: 200 }
      );

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.statusCode).toBe(502);
      expect(result.responseBody).toBe("Bad Gateway");
      expect(result.failureReason).toBe("HTTP_502");
      expect(result.isDeadLettered).toBe(true);
      expect(result.request.body).toContain("pay_123");
      expect(result.request.headers["X-OphirPay-Signature"]).toBeDefined();

      const metrics = getMetricsSnapshot();
      expect(metrics.webhooks_failed_total).toBe(1);
      expect(metrics.webhooks_dead_letter_total).toBe(1);
      expect(metrics.delivery_attempts).toEqual([
        { delivery_type: "webhook", attempt_number: 1, count: 1 },
        { delivery_type: "webhook", attempt_number: 2, count: 1 },
      ]);
    });

    it("persistDeliveryResult writes dead-letter state with payload, last response, and failure reason", async () => {
      const mockCreate = vi.mocked(prisma.webhookDelivery.create);
      mockCreate.mockResolvedValueOnce({ id: "del_dlq_1" } as never);

      const deliveryDetails = {
        success: false,
        statusCode: 504,
        latencyMs: 1500,
        attempts: 3,
        errorMessage: "HTTP 504",
        failureReason: "HTTP_504",
        isDeadLettered: true,
        delivered: false,
        status: 504,
        responseBody: "Gateway Timeout Error",
        durationMs: 1500,
        blocked: false,
        error: "HTTP 504",
        request: {
          canonicalBody: JSON.stringify({ ...SAMPLE_PAYLOAD, signature: "" }),
          body: JSON.stringify(SAMPLE_PAYLOAD),
          signature: "sig123",
          headers: { "Content-Type": "application/json" },
        },
      };

      const id = await persistDeliveryResult("wh_abc", "evt_xyz", deliveryDetails);

      expect(id).toBe("del_dlq_1");
      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          webhookId: "wh_abc",
          eventId: "evt_xyz",
          status: "DEAD_LETTER",
          isDeadLettered: true,
          responseCode: 504,
          responseBody: "Gateway Timeout Error",
          failureReason: "HTTP_504",
          errorMessage: "HTTP 504",
          requestBody: JSON.stringify(SAMPLE_PAYLOAD),
          attempts: 3,
        }),
      });
    });

    it("getDeadLetterDeliveries queries deliveries with status DEAD_LETTER or isDeadLettered: true", async () => {
      const mockFindMany = vi.mocked(prisma.webhookDelivery.findMany);
      const mockRows = [
        {
          id: "dl_1",
          webhookId: "wh_1",
          eventId: "evt_1",
          status: "DEAD_LETTER",
          isDeadLettered: true,
          responseCode: 500,
          responseBody: "Internal Server Error",
          failureReason: "HTTP_500",
          attempts: 3,
          deliveredAt: new Date("2026-09-28T01:00:00Z"),
          event: {
            id: "evt_1",
            event: "payment.completed",
            timestamp: new Date("2026-09-28T00:59:00Z"),
            data: JSON.stringify(SAMPLE_PAYLOAD.data),
          },
        },
      ];
      mockFindMany.mockResolvedValueOnce(mockRows as never);

      const items = await getDeadLetterDeliveries("wh_1", 10);

      expect(items).toHaveLength(1);
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            webhookId: "wh_1",
            OR: [{ status: "DEAD_LETTER" }, { isDeadLettered: true }],
          },
          take: 10,
        })
      );
      expect(items[0].failureReason).toBe("HTTP_500");
      expect(items[0].event.data).toContain("pay_123");
    });
  });

  // ── Criterion 3: Bulk redelivery from dead-letter state & auditing ──

  describe("Bulk redelivery action from dead-letter state is available and audited", () => {
    it("bulk redelivers dead letters, creates audit log entry, and clears active dead-letter status on success", async () => {
      const mockWebhookFind = vi.mocked(prisma.webhook.findFirst);
      const mockDeliveryFind = vi.mocked(prisma.webhookDelivery.findMany);
      const mockDeliveryCreate = vi.mocked(prisma.webhookDelivery.create);
      const mockDeliveryUpdate = vi.mocked(prisma.webhookDelivery.update);
      const mockAuditCreate = vi.mocked(prisma.auditLog.create);

      mockWebhookFind.mockResolvedValueOnce({
        id: "wh_test",
        userId: "user_1",
        url: "https://subscriber.example.com/webhook",
        secret: SECRET,
        isActive: true,
      } as never);

      mockDeliveryFind.mockResolvedValueOnce([
        {
          id: "dl_101",
          webhookId: "wh_test",
          eventId: "evt_101",
          status: "DEAD_LETTER",
          isDeadLettered: true,
          deliveredAt: new Date(),
          event: {
            id: "evt_101",
            event: "payment.completed",
            timestamp: new Date("2026-09-28T02:00:00Z"),
            data: JSON.stringify({ paymentId: "p_101" }),
          },
        },
        {
          id: "dl_102",
          webhookId: "wh_test",
          eventId: "evt_102",
          status: "DEAD_LETTER",
          isDeadLettered: true,
          deliveredAt: new Date(),
          event: {
            id: "evt_102",
            event: "payment.completed",
            timestamp: new Date("2026-09-28T02:05:00Z"),
            data: JSON.stringify({ paymentId: "p_102" }),
          },
        },
      ] as never);

      // Endpoint is now healthy: returns 200 OK
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue("OK"),
      });

      mockDeliveryCreate.mockResolvedValue({ id: "new_del" } as never);
      mockDeliveryUpdate.mockResolvedValue({} as never);
      mockAuditCreate.mockResolvedValue({ id: "audit_1" } as never);

      const result = await bulkRedeliverDeadLetters("wh_test", {
        userId: "user_1",
        limit: 10,
      });

      expect(result.totalSelected).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.batchId).toBeDefined();

      // Verified prior deliveries updated to no longer be dead letter
      expect(mockDeliveryUpdate).toHaveBeenCalledTimes(2);
      expect(mockDeliveryUpdate).toHaveBeenCalledWith({
        where: { id: "dl_101" },
        data: { isDeadLettered: false },
      });
      expect(mockDeliveryUpdate).toHaveBeenCalledWith({
        where: { id: "dl_102" },
        data: { isDeadLettered: false },
      });

      // Verified audit log entry recorded
      expect(mockAuditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "webhook:dead_letter_bulk_redeliver",
          actor: "user_1",
          target: "wh_test",
          details: expect.objectContaining({
            batchId: result.batchId,
            totalSelected: 2,
            succeeded: 2,
            failed: 0,
            deliveryIds: ["dl_101", "dl_102"],
          }),
        }),
      });
    });

    it("rejects bulk redelivery if webhook is paused", async () => {
      vi.mocked(prisma.webhook.findFirst).mockResolvedValueOnce({
        id: "wh_paused",
        userId: "user_1",
        url: "https://example.com/webhook",
        isActive: false,
      } as never);

      await expect(
        bulkRedeliverDeadLetters("wh_paused", { userId: "user_1" })
      ).rejects.toThrow("Webhook is paused — activate it before redelivering");
    });
  });

  // ── Criterion 3 & 4: API Endpoints (Dead-Letter Query & Bulk Redeliver) ──

  describe("API Routes: GET & POST /api/webhooks/[id]/deliveries/dead-letter", () => {
    it("GET /api/webhooks/[id]/deliveries/dead-letter returns queryable dead-letter queue", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce({
        userId: "user_1",
        publicKey: "G...",
      } as never);

      vi.mocked(prisma.webhook.findFirst).mockResolvedValueOnce({
        id: "wh_1",
        userId: "user_1",
      } as never);

      vi.mocked(prisma.webhookDelivery.findMany).mockResolvedValueOnce([
        {
          id: "del_1",
          eventId: "evt_1",
          status: "DEAD_LETTER",
          isDeadLettered: true,
          responseCode: 504,
          responseBody: "Gateway Timeout",
          latencyMs: 5000,
          attempts: 3,
          errorMessage: "Webhook delivery timed out after 5000ms",
          failureReason: "TIMEOUT",
          targetUrl: "https://api.subscriber.com/hook",
          deliveredAt: new Date("2026-09-28T02:00:00Z"),
          event: {
            id: "evt_1",
            event: "payment.completed",
            timestamp: new Date("2026-09-28T01:59:00Z"),
            data: JSON.stringify({ id: "pay_1" }),
          },
        },
      ] as never);

      const req = new Request("http://localhost/api/webhooks/wh_1/deliveries/dead-letter?limit=10");
      const res = await getDeadLetterRoute(req, {
        params: Promise.resolve({ id: "wh_1" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0]).toMatchObject({
        id: "del_1",
        eventType: "payment.completed",
        failureReason: "TIMEOUT",
        status: "DEAD_LETTER",
        isDeadLettered: true,
        responseCode: 504,
        responseBody: "Gateway Timeout",
        payload: JSON.stringify({ id: "pay_1" }),
      });
    });

    it("POST /api/webhooks/[id]/deliveries/dead-letter triggers bulk redelivery", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce({
        userId: "user_1",
        publicKey: "G...",
      } as never);

      vi.mocked(prisma.webhook.findFirst).mockResolvedValueOnce({
        id: "wh_1",
        userId: "user_1",
        url: "https://api.subscriber.com/hook",
        secret: SECRET,
        isActive: true,
      } as never);

      vi.mocked(prisma.webhookDelivery.findMany).mockResolvedValueOnce([
        {
          id: "del_1",
          webhookId: "wh_1",
          eventId: "evt_1",
          status: "DEAD_LETTER",
          isDeadLettered: true,
          deliveredAt: new Date(),
          event: {
            id: "evt_1",
            event: "payment.completed",
            timestamp: new Date(),
            data: JSON.stringify({ id: "pay_1" }),
          },
        },
      ] as never);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue("OK"),
      });

      vi.mocked(prisma.webhookDelivery.create).mockResolvedValue({ id: "del_new" } as never);
      vi.mocked(prisma.webhookDelivery.update).mockResolvedValue({} as never);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({ id: "aud_1" } as never);

      const req = new Request("http://localhost/api/webhooks/wh_1/deliveries/dead-letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryIds: ["del_1"] }),
      });

      const res = await postDeadLetterRoute(req, {
        params: Promise.resolve({ id: "wh_1" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.totalSelected).toBe(1);
      expect(json.data.succeeded).toBe(1);
      expect(json.data.failed).toBe(0);
    });

    it("GET /api/webhooks/[id]/deliveries?deadLetterOnly=true filters for dead letter entries", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce({
        userId: "user_1",
        publicKey: "G...",
      } as never);

      vi.mocked(prisma.webhook.findFirst).mockResolvedValueOnce({
        id: "wh_1",
        userId: "user_1",
      } as never);

      const mockFindMany = vi.mocked(prisma.webhookDelivery.findMany);
      mockFindMany.mockResolvedValueOnce([] as never);

      const req = new Request("http://localhost/api/webhooks/wh_1/deliveries?deadLetterOnly=true");
      const res = await getDeliveries(req, {
        params: Promise.resolve({ id: "wh_1" }),
      });

      expect(res.status).toBe(200);
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [{ status: "DEAD_LETTER" }, { isDeadLettered: true }],
          }),
        })
      );
    });

    it("GET /api/webhooks/[id]/deliveries/stats exposes counts and metrics for dashboard", async () => {
      vi.mocked(authSession.getAuthContext).mockResolvedValueOnce({
        userId: "user_1",
        publicKey: "G...",
      } as never);

      vi.mocked(prisma.webhook.findFirst).mockResolvedValueOnce({
        id: "wh_1",
        userId: "user_1",
      } as never);

      vi.mocked(prisma.webhookDelivery.count)
        .mockResolvedValueOnce(20) // total
        .mockResolvedValueOnce(15) // successful
        .mockResolvedValueOnce(2)  // failed
        .mockResolvedValueOnce(3); // dead-letter

      incMetric("webhooks_dead_letter_total", 3);

      const req = new Request("http://localhost/api/webhooks/wh_1/deliveries/stats");
      const res = await getDeliveryStats(req, {
        params: Promise.resolve({ id: "wh_1" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.counts).toEqual({
        total: 20,
        successful: 15,
        failed: 2,
        deadLetter: 3,
      });
      expect(json.data.metrics.webhooks_dead_letter_total).toBe(3);
    });
  });

  // ── Criterion 4: Prometheus Alerts in monitoring/prometheus-alerts.yml ──

  describe("Prometheus alerts for dead-letter queue", () => {
    it("contains WebhookDeadLetterQueueHigh and WebhookDeadLetterSpike in prometheus-alerts.yml", () => {
      const alertFilePath = path.join(process.cwd(), "monitoring/prometheus-alerts.yml");
      const content = fs.readFileSync(alertFilePath, "utf8");
      const parsed = yaml.load(content) as {
        groups: Array<{ rules: Array<{ alert: string; expr: string; labels: Record<string, string> }> }>;
      };

      const rules = parsed.groups.flatMap((g) => g.rules);
      const alertNames = rules.map((r) => r.alert);

      expect(alertNames).toContain("WebhookDeadLetterQueueHigh");
      expect(alertNames).toContain("WebhookDeadLetterSpike");

      const queueHigh = rules.find((r) => r.alert === "WebhookDeadLetterQueueHigh");
      expect(queueHigh?.expr).toContain("ophirpay_webhooks_dead_letter_total");
      expect(queueHigh?.labels.component).toBe("webhooks");

      const spike = rules.find((r) => r.alert === "WebhookDeadLetterSpike");
      expect(spike?.expr).toContain("ophirpay_webhooks_dead_letter_total");
      expect(spike?.labels.severity).toBe("critical");
    });
  });
});
