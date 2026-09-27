// SPDX-License-Identifier: MIT

/**
 * Payment Request Expiration & Reminder Service (issue #810).
 * Handles:
 * - Automated transition of overdue payment requests
 * - Exactly-once overdue webhook & notification dispatch
 * - Rate-limited reminder dispatch with usage tracking
 */

import prisma from "@/lib/prisma";
import { WEBHOOK_EVENTS } from "@/app/api/webhooks/event-types";
import { dispatchWebhookEventAsync } from "@/lib/webhook-dispatcher";
import { logger } from "@/lib/logger";

export const REMINDER_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown between reminders
export const MAX_REMINDERS_PER_REQUEST = 5;

export interface OverdueTransitionResult {
  transitionedCount: number;
  transitionedIds: string[];
}

export interface ReminderResult {
  success: boolean;
  requestId: string;
  remindersCount: number;
  lastReminderAt: Date;
  nextReminderAllowedAt: Date;
}

export class ReminderRateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "ReminderRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ReminderLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReminderLimitExceededError";
  }
}

/**
 * Sweeps for payment requests that have passed their dueDate and are still PENDING.
 * Transitions their status to OVERDUE and dispatches webhook events exactly once.
 */
export async function transitionOverduePaymentRequests(
  referenceTime: Date = new Date()
): Promise<OverdueTransitionResult> {
  const overdueRequests = await prisma.paymentRequest.findMany({
    where: {
      status: "PENDING",
      dueDate: {
        lt: referenceTime,
      },
      overdueNotifiedAt: null,
    },
  });

  if (overdueRequests.length === 0) {
    return { transitionedCount: 0, transitionedIds: [] };
  }

  const transitionedIds: string[] = [];

  for (const req of overdueRequests) {
    try {
      await prisma.paymentRequest.update({
        where: { id: req.id },
        data: {
          status: "OVERDUE",
          overdueNotifiedAt: referenceTime,
        },
      });

      transitionedIds.push(req.id);

      dispatchWebhookEventAsync(
        WEBHOOK_EVENTS.REQUEST_OVERDUE,
        {
          requestId: req.id,
          amount: Number(req.amount),
          assetCode: req.assetCode,
          description: req.description,
          dueDate: req.dueDate?.toISOString(),
          status: "OVERDUE",
          recipientAddress: req.recipientAddress,
          transitionedAt: referenceTime.toISOString(),
        },
        req.userId
      );

      logger.info("Payment request marked overdue", {
        requestId: req.id,
        userId: req.userId,
        dueDate: req.dueDate,
      });
    } catch (err) {
      logger.error("Failed to transition overdue payment request", {
        requestId: req.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    transitionedCount: transitionedIds.length,
    transitionedIds,
  };
}

/**
 * Sends a rate-limited reminder for an outstanding payment request.
 */
export async function sendPaymentRequestReminder(
  requestId: string,
  userId: string,
  referenceTime: Date = new Date()
): Promise<ReminderResult> {
  const request = await prisma.paymentRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new Error("Payment request not found");
  }

  if (request.userId !== userId) {
    throw new Error("Unauthorized to send reminder for this payment request");
  }

  if (request.status === "PAID") {
    throw new Error("Cannot send reminder for an already paid payment request");
  }

  if (request.status === "CANCELLED") {
    throw new Error("Cannot send reminder for a cancelled payment request");
  }

  if (request.remindersCount >= MAX_REMINDERS_PER_REQUEST) {
    throw new ReminderLimitExceededError(
      `Maximum reminder limit reached (${MAX_REMINDERS_PER_REQUEST} reminders sent).`
    );
  }

  if (request.lastReminderAt) {
    const elapsedMs = referenceTime.getTime() - new Date(request.lastReminderAt).getTime();
    if (elapsedMs < REMINDER_COOLDOWN_MS) {
      const remainingSeconds = Math.ceil((REMINDER_COOLDOWN_MS - elapsedMs) / 1000);
      throw new ReminderRateLimitError(
        `Please wait before sending another reminder. Retry in ${Math.ceil(remainingSeconds / 60)} minutes.`,
        remainingSeconds
      );
    }
  }

  const updated = await prisma.paymentRequest.update({
    where: { id: requestId },
    data: {
      remindersCount: { increment: 1 },
      lastReminderAt: referenceTime,
    },
  });

  dispatchWebhookEventAsync(
    WEBHOOK_EVENTS.REQUEST_REMINDER,
    {
      requestId: request.id,
      amount: Number(request.amount),
      assetCode: request.assetCode,
      description: request.description,
      recipientAddress: request.recipientAddress,
      remindersCount: updated.remindersCount,
      remindedAt: referenceTime.toISOString(),
      status: updated.status,
    },
    request.userId
  );

  logger.info("Payment request reminder sent", {
    requestId: request.id,
    remindersCount: updated.remindersCount,
  });

  const nextAllowed = new Date(referenceTime.getTime() + REMINDER_COOLDOWN_MS);

  return {
    success: true,
    requestId: request.id,
    remindersCount: updated.remindersCount,
    lastReminderAt: referenceTime,
    nextReminderAllowedAt: nextAllowed,
  };
}

export interface PaidTransitionResult {
  success: boolean;
  requestId: string;
  alreadyPaid: boolean;
  status: string;
}

/**
 * Transitions a payment request to PAID and dispatches webhook exactly once.
 */
export async function transitionPaymentRequestPaid(
  requestId: string,
  transactionHash?: string,
  referenceTime: Date = new Date()
): Promise<PaidTransitionResult> {
  const req = await prisma.paymentRequest.findUnique({
    where: { id: requestId },
  });

  if (!req) {
    throw new Error("Payment request not found");
  }

  // Idempotency: if already paid, do not re-emit webhook/notifications
  if (req.status === "PAID") {
    return {
      success: true,
      requestId: req.id,
      alreadyPaid: true,
      status: req.status,
    };
  }

  const updated = await prisma.paymentRequest.update({
    where: { id: requestId },
    data: {
      status: "PAID",
      transactionHash: transactionHash || req.transactionHash,
    },
  });

  dispatchWebhookEventAsync(
    WEBHOOK_EVENTS.REQUEST_PAID,
    {
      requestId: updated.id,
      amount: Number(updated.amount),
      assetCode: updated.assetCode,
      description: updated.description,
      recipientAddress: updated.recipientAddress,
      transactionHash: updated.transactionHash,
      paidAt: referenceTime.toISOString(),
      status: "PAID",
    },
    updated.userId
  );

  logger.info("Payment request marked as paid", {
    requestId: updated.id,
    userId: updated.userId,
    transactionHash: updated.transactionHash,
  });

  return {
    success: true,
    requestId: updated.id,
    alreadyPaid: false,
    status: updated.status,
  };
}
