// SPDX-License-Identifier: MIT

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  default: {
    paymentRequest: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

// Mock auth-session
vi.mock("@/lib/auth-session", () => ({
  getAuthContext: vi.fn(),
}));

// Mock csrf
vi.mock("@/lib/csrf", () => ({
  verifyCsrf: vi.fn(() => null),
}));

// Mock webhook-dispatcher
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEventAsync: vi.fn(),
}));

// Mock metrics
vi.mock("@/lib/metrics-middleware", () => ({
  withMetrics: (_name: string, fn: unknown) => fn,
}));

vi.mock("@/lib/request-logging", () => ({
  withRequestLogging: (fn: unknown) => fn,
}));

import prisma from "@/lib/prisma";
import { getAuthContext } from "@/lib/auth-session";
import { dispatchWebhookEventAsync } from "@/lib/webhook-dispatcher";
import {
  transitionOverduePaymentRequests,
  sendPaymentRequestReminder,
  transitionPaymentRequestPaid,
  ReminderRateLimitError,
  ReminderLimitExceededError,
  REMINDER_COOLDOWN_MS,
  MAX_REMINDERS_PER_REQUEST,
} from "@/lib/payment-request-expiration";
import { POST as expirePost } from "@/app/api/requests/expire/route";
import { POST as remindPost } from "@/app/api/requests/[id]/remind/route";
import {
  generatePaymentLink,
  parsePaymentLink,
} from "@/lib/payment-link";
import {
    saveNotificationPreferences,
  emitPaymentNotification,
  NOTIFY,
  normalizePaymentEvent,
} from "@/lib/notifications";

describe("Payment Request Expiration and Reminders (issue #810)", () => {
  const mockUserId = "usr_test123";
  const mockNow = new Date("2026-09-27T12:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("transitionOverduePaymentRequests", () => {
    it("transitions overdue PENDING requests to OVERDUE and emits webhook exactly once", async () => {
      const overdueReq = {
        id: "req_1",
        userId: mockUserId,
        amount: 50,
        assetCode: "XLM",
        description: "Invoice #1",
        dueDate: new Date("2026-09-26T12:00:00Z"),
        status: "PENDING",
        recipientAddress: "GCAL...1111",
        overdueNotifiedAt: null,
      };

      vi.mocked(prisma.paymentRequest.findMany).mockResolvedValueOnce([overdueReq] as never);
      vi.mocked(prisma.paymentRequest.update).mockResolvedValueOnce({
        ...overdueReq,
        status: "OVERDUE",
        overdueNotifiedAt: mockNow,
      } as never);

      const result = await transitionOverduePaymentRequests(mockNow);

      expect(result.transitionedCount).toBe(1);
      expect(result.transitionedIds).toEqual(["req_1"]);

      expect(prisma.paymentRequest.update).toHaveBeenCalledWith({
        where: { id: "req_1" },
        data: {
          status: "OVERDUE",
          overdueNotifiedAt: mockNow,
        },
      });

      expect(dispatchWebhookEventAsync).toHaveBeenCalledWith(
        "request.overdue",
        expect.objectContaining({
          requestId: "req_1",
          status: "OVERDUE",
          amount: 50,
          transitionedAt: mockNow.toISOString(),
        }),
        mockUserId
      );
    });

    it("returns zero transitioned count when no overdue requests exist", async () => {
      vi.mocked(prisma.paymentRequest.findMany).mockResolvedValueOnce([]);

      const result = await transitionOverduePaymentRequests(mockNow);

      expect(result.transitionedCount).toBe(0);
      expect(result.transitionedIds).toEqual([]);
      expect(prisma.paymentRequest.update).not.toHaveBeenCalled();
      expect(dispatchWebhookEventAsync).not.toHaveBeenCalled();
    });
  });

  describe("sendPaymentRequestReminder", () => {
    it("successfully sends a reminder within limits and emits webhook", async () => {
      const activeReq = {
        id: "req_2",
        userId: mockUserId,
        amount: 100,
        assetCode: "XLM",
        description: "Services",
        recipientAddress: "GCAL...2222",
        status: "PENDING",
        remindersCount: 1,
        lastReminderAt: new Date(mockNow.getTime() - REMINDER_COOLDOWN_MS - 1000), // cooldown passed
      };

      vi.mocked(prisma.paymentRequest.findUnique).mockResolvedValueOnce(activeReq as never);
      vi.mocked(prisma.paymentRequest.update).mockResolvedValueOnce({
        ...activeReq,
        remindersCount: 2,
        lastReminderAt: mockNow,
      } as never);

      const result = await sendPaymentRequestReminder("req_2", mockUserId, mockNow);

      expect(result.success).toBe(true);
      expect(result.remindersCount).toBe(2);
      expect(result.lastReminderAt).toEqual(mockNow);

      expect(dispatchWebhookEventAsync).toHaveBeenCalledWith(
        "request.reminder",
        expect.objectContaining({
          requestId: "req_2",
          remindersCount: 2,
        }),
        mockUserId
      );
    });

    it("enforces cooldown period between reminders", async () => {
      const recentReminderReq = {
        id: "req_3",
        userId: mockUserId,
        amount: 100,
        status: "PENDING",
        remindersCount: 1,
        lastReminderAt: new Date(mockNow.getTime() - 15 * 60 * 1000), // 15 mins ago (< 1h)
      };

      vi.mocked(prisma.paymentRequest.findUnique).mockResolvedValueOnce(recentReminderReq as never);

      await expect(
        sendPaymentRequestReminder("req_3", mockUserId, mockNow)
      ).rejects.toThrow(ReminderRateLimitError);

      expect(prisma.paymentRequest.update).not.toHaveBeenCalled();
    });

    it("enforces maximum reminders limit per request", async () => {
      const maxedReq = {
        id: "req_4",
        userId: mockUserId,
        amount: 100,
        status: "PENDING",
        remindersCount: MAX_REMINDERS_PER_REQUEST,
        lastReminderAt: new Date(mockNow.getTime() - REMINDER_COOLDOWN_MS - 1000),
      };

      vi.mocked(prisma.paymentRequest.findUnique).mockResolvedValueOnce(maxedReq as never);

      await expect(
        sendPaymentRequestReminder("req_4", mockUserId, mockNow)
      ).rejects.toThrow(ReminderLimitExceededError);

      expect(prisma.paymentRequest.update).not.toHaveBeenCalled();
    });

    it("rejects reminder for already paid request", async () => {
      const paidReq = {
        id: "req_5",
        userId: mockUserId,
        status: "PAID",
        remindersCount: 0,
      };

      vi.mocked(prisma.paymentRequest.findUnique).mockResolvedValueOnce(paidReq as never);

      await expect(
        sendPaymentRequestReminder("req_5", mockUserId, mockNow)
      ).rejects.toThrow("Cannot send reminder for an already paid payment request");
    });

    it("rejects reminder from unauthorized user", async () => {
      const request = {
        id: "req_6",
        userId: "other_user",
        status: "PENDING",
      };

      vi.mocked(prisma.paymentRequest.findUnique).mockResolvedValueOnce(request as never);

      await expect(
        sendPaymentRequestReminder("req_6", mockUserId, mockNow)
      ).rejects.toThrow("Unauthorized");
    });
  });

  describe("transitionPaymentRequestPaid (Exactly-Once Dispatch)", () => {
    it("transitions request to PAID and dispatches webhook event", async () => {
      const pendingReq = {
        id: "req_paid_1",
        userId: mockUserId,
        amount: 250,
        assetCode: "XLM",
        description: "Consulting",
        status: "PENDING",
        recipientAddress: "GCAL...5555",
      };

      vi.mocked(prisma.paymentRequest.findUnique).mockResolvedValueOnce(pendingReq as never);
      vi.mocked(prisma.paymentRequest.update).mockResolvedValueOnce({
        ...pendingReq,
        status: "PAID",
        transactionHash: "tx_abc123",
      } as never);

      const res = await transitionPaymentRequestPaid("req_paid_1", "tx_abc123", mockNow);

      expect(res.success).toBe(true);
      expect(res.alreadyPaid).toBe(false);
      expect(res.status).toBe("PAID");

      expect(dispatchWebhookEventAsync).toHaveBeenCalledWith(
        "request.paid",
        expect.objectContaining({
          requestId: "req_paid_1",
          transactionHash: "tx_abc123",
          status: "PAID",
        }),
        mockUserId
      );
    });

    it("does not re-emit webhook if request is already marked PAID", async () => {
      const alreadyPaidReq = {
        id: "req_paid_2",
        userId: mockUserId,
        status: "PAID",
        transactionHash: "tx_abc123",
      };

      vi.mocked(prisma.paymentRequest.findUnique).mockResolvedValueOnce(alreadyPaidReq as never);

      const res = await transitionPaymentRequestPaid("req_paid_2", "tx_abc123", mockNow);

      expect(res.success).toBe(true);
      expect(res.alreadyPaid).toBe(true);
      expect(prisma.paymentRequest.update).not.toHaveBeenCalled();
      expect(dispatchWebhookEventAsync).not.toHaveBeenCalled();
    });
  });

  describe("API Routes", () => {
    it("POST /api/requests/expire triggers transition and returns results", async () => {
      vi.mocked(prisma.paymentRequest.findMany).mockResolvedValueOnce([]);

      const response = await expirePost(new Request("https://example.com/api/requests/expire", { method: "POST" }));
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data.transitionedCount).toBe(0);
    });

    it("POST /api/requests/[id]/remind requires authentication", async () => {
      vi.mocked(getAuthContext).mockResolvedValueOnce(null);

      const req = new Request("https://example.com/api/requests/req_1/remind", { method: "POST" });
      const response = await remindPost(req, {
        params: Promise.resolve({ id: "req_1" }),
      });

      expect(response.status).toBe(401);
    });

    it("POST /api/requests/[id]/remind maps rate limit error to 429", async () => {
      vi.mocked(getAuthContext).mockResolvedValueOnce({ userId: mockUserId, type: "session" } as never);
      const recentReminderReq = {
        id: "req_1",
        userId: mockUserId,
        status: "PENDING",
        remindersCount: 1,
        lastReminderAt: new Date(Date.now() - 5 * 60 * 1000),
      };
      vi.mocked(prisma.paymentRequest.findUnique).mockResolvedValueOnce(recentReminderReq as never);

      const req = new Request("https://example.com/api/requests/req_1/remind", { method: "POST" });
      const response = await remindPost(req, {
        params: Promise.resolve({ id: "req_1" }),
      });

      expect(response.status).toBe(429);
      const json = await response.json();
      expect(json.error.message).toContain("Please wait before sending another reminder");
    });
  });

  describe("Payment Link with Due Date & Request ID", () => {
    const validAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    it("generates and parses payment link with due date and request ID", () => {
      const link = generatePaymentLink({
        destination: validAddress,
        amount: "150",
        assetCode: "USDC",
        memo: "inv-99",
        dueDate: "2026-10-01T00:00:00.000Z",
        requestId: "req_xyz",
      });

      const parsed = parsePaymentLink(link);
      expect(parsed).toEqual({
        destination: validAddress,
        amount: "150",
        assetCode: "USDC",
        memo: "inv-99",
        dueDate: "2026-10-01T00:00:00.000Z",
        requestId: "req_xyz",
      });
    });
  });

  describe("Notification Preferences & Event Normalization", () => {
    it("normalizes request.overdue, request.reminder, and request.paid events", () => {
      const overdueEvt = normalizePaymentEvent({
        event: "request:overdue",
        amount: "75 XLM",
      });
      expect(overdueEvt.type).toBe("request.overdue");
      expect(overdueEvt.title).toContain("Payment Request Overdue");

      const reminderEvt = normalizePaymentEvent({
        event: "request:reminder",
        amount: "75 XLM",
      });
      expect(reminderEvt.type).toBe("request.reminder");
      expect(reminderEvt.title).toBe("Payment Request Reminder");

      const paidEvt = normalizePaymentEvent({
        event: "request:paid",
        amount: "75 XLM",
      });
      expect(paidEvt.type).toBe("request.paid");
      expect(paidEvt.title).toContain("Payment Request Paid");
    });

    it("respects notification preferences when emitting events", () => {
      const listener = vi.fn();
      window.addEventListener("ophirpay:notification", listener);

      saveNotificationPreferences({ requestEvents: false });

      emitPaymentNotification({
        type: "request.overdue",
        amount: "10 XLM",
      });

      expect(listener).not.toHaveBeenCalled();

      saveNotificationPreferences({ requestEvents: true });
      const allowedNotif = emitPaymentNotification({
        type: "request.overdue",
        amount: "10 XLM",
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(allowedNotif.type).toBe("request.overdue");

      window.removeEventListener("ophirpay:notification", listener);
    });

    it("NOTIFY helpers trigger request notifications", () => {
      const notif = NOTIFY.requestOverdue("100", "req_99");
      expect(notif).not.toBeNull();

      const reminderNotif = NOTIFY.requestReminder("100", 2, "req_99");
      expect(reminderNotif).not.toBeNull();

      const paidNotif = NOTIFY.requestPaid("100", "req_99", "tx_123");
      expect(paidNotif).not.toBeNull();
    });
  });
});
