// SPDX-License-Identifier: MIT

import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { invalidateCache } from "@/lib/api-cache";
import {
  generateApiKey,
  hashApiKeyV1,
  deriveKeyPrefix,
  DEFAULT_ROTATION_OVERLAP_MS,
} from "@/lib/api-auth";

export interface RotateApiKeyInput {
  id: string;
  name?: string;
  overlapHours?: number;
  overlapSeconds?: number;
  overlapWindow?: string;
}

export interface RotateApiKeyResult {
  oldKey: {
    id: string;
    name: string;
    prefix: string;
    expiresAt: Date;
    rotatedAt: Date;
    status: "rotating";
  };
  newKey: {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    key: string;
    rotatedFromId: string;
    createdAt: Date;
  };
  overlapExpiresAt: Date;
  overlapWindowMs: number;
}

export interface ConfirmRotationResult {
  confirmed: boolean;
  expiredKeyId: string;
  replacementKeyId?: string;
}

export interface CancelRotationResult {
  cancelled: boolean;
  restoredKeyId: string;
  revokedKeyId: string;
}

/**
 * Determine the overlap window duration in milliseconds based on user inputs.
 */
export function parseOverlapWindowMs(options: {
  overlapHours?: unknown;
  overlapSeconds?: unknown;
  overlapWindow?: unknown;
}): number {
  if (
    typeof options.overlapSeconds === "number" &&
    Number.isFinite(options.overlapSeconds) &&
    options.overlapSeconds > 0
  ) {
    return Math.floor(options.overlapSeconds * 1000);
  }

  if (
    typeof options.overlapHours === "number" &&
    Number.isFinite(options.overlapHours) &&
    options.overlapHours > 0
  ) {
    return Math.floor(options.overlapHours * 60 * 60 * 1000);
  }

  if (typeof options.overlapWindow === "string") {
    const trimmed = options.overlapWindow.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/);
    if (match) {
      const val = parseFloat(match[1]!);
      const unit = match[2] ?? "h";
      if (!Number.isNaN(val) && val > 0) {
        switch (unit) {
          case "s":
            return Math.floor(val * 1000);
          case "m":
            return Math.floor(val * 60 * 1000);
          case "h":
            return Math.floor(val * 60 * 60 * 1000);
          case "d":
            return Math.floor(val * 24 * 60 * 60 * 1000);
          case "w":
            return Math.floor(val * 7 * 24 * 60 * 60 * 1000);
        }
      }
    }
  }

  return DEFAULT_ROTATION_OVERLAP_MS;
}

/**
 * Determine high-level status of an API key given its rotation and expiration timestamps.
 */
export function getApiKeyRotationStatus(key: {
  expiresAt: Date | string | null;
  rotatedAt?: Date | string | null;
  rotatedFromId?: string | null;
}): "active" | "rotating" | "rotated_expired" | "expired" {
  const now = Date.now();
  const expiresAtMs = key.expiresAt ? new Date(key.expiresAt).getTime() : null;
  const isExpired = expiresAtMs !== null && expiresAtMs <= now;

  if (key.rotatedAt) {
    return isExpired ? "rotated_expired" : "rotating";
  }

  if (isExpired) {
    return "expired";
  }

  return "active";
}

/**
 * Execute zero-downtime rotation for an API key.
 * Issues a replacement key with identical scopes, records parent/child relationship,
 * and sets an overlap window on the parent key before expiry.
 */
export async function rotateApiKey(
  userId: string,
  input: RotateApiKeyInput
): Promise<RotateApiKeyResult> {
  const { id } = input;
  if (!id || typeof id !== "string") {
    throw new Error("Key ID is required");
  }

  const oldKey = await prisma.apiKey.findFirst({
    where: { id, userId },
  });

  if (!oldKey) {
    throw new Error("Key not found");
  }

  const now = new Date();

  // Reject already expired key
  if (oldKey.expiresAt && oldKey.expiresAt.getTime() <= now.getTime()) {
    throw new Error("Cannot rotate an expired key");
  }

  // Reject key that is already in active overlap window
  if (
    oldKey.rotatedAt &&
    oldKey.expiresAt &&
    oldKey.expiresAt.getTime() > now.getTime()
  ) {
    throw new Error(
      `Key is already undergoing rotation. Overlap window active until ${oldKey.expiresAt.toISOString()}`
    );
  }

  const windowMs = parseOverlapWindowMs(input);
  let overlapExpiresAt = new Date(now.getTime() + windowMs);

  // If old key already had an earlier expiration date, do not extend it
  if (oldKey.expiresAt && oldKey.expiresAt.getTime() < overlapExpiresAt.getTime()) {
    overlapExpiresAt = oldKey.expiresAt;
  }

  // Mint new replacement key
  const rawKey = generateApiKey();
  const keyHash = hashApiKeyV1(rawKey);
  const prefix = deriveKeyPrefix(rawKey);
  const newKeyName =
    typeof input.name === "string" && input.name.trim()
      ? input.name.trim()
      : `${oldKey.name} (rotated)`;

  const [updatedOldKey, newKey] = await prisma.$transaction([
    prisma.apiKey.update({
      where: { id: oldKey.id },
      data: {
        rotatedAt: now,
        preRotationExpiresAt: oldKey.expiresAt,
        expiresAt: overlapExpiresAt,
      },
    }),
    prisma.apiKey.create({
      data: {
        name: newKeyName,
        keyHash,
        prefix,
        userId,
        scopes: oldKey.scopes, // identical scopes preserved!
        rotatedFromId: oldKey.id,
      },
    }),
  ]);

  // Persist audit log entry
  try {
    await prisma.auditLog.create({
      data: {
        action: "api_key:rotate",
        actor: userId,
        target: oldKey.id,
        details: {
          oldKeyId: oldKey.id,
          oldKeyPrefix: oldKey.prefix,
          oldKeyName: oldKey.name,
          newKeyId: newKey.id,
          newKeyPrefix: newKey.prefix,
          newKeyName: newKey.name,
          scopes: newKey.scopes,
          overlapExpiresAt: overlapExpiresAt.toISOString(),
          overlapHours: Math.round(windowMs / (60 * 60 * 1000)),
        },
      },
    });
  } catch (err) {
    logger.warn("Failed to create audit log for api_key:rotate", { error: String(err) });
  }

  recordAudit({
    action: AUDIT_ACTIONS.API_KEY_ROTATE,
    actor: userId,
    target: oldKey.id,
    details: {
      newKeyId: newKey.id,
      overlapExpiresAt: overlapExpiresAt.toISOString(),
    },
  });

  logger.info("API key rotated", {
    oldKeyId: oldKey.id,
    newKeyId: newKey.id,
    overlapExpiresAt: overlapExpiresAt.toISOString(),
    scopes: newKey.scopes,
  });

  await invalidateCache("audit-log").catch(() => {});

  return {
    oldKey: {
      id: updatedOldKey.id,
      name: updatedOldKey.name,
      prefix: updatedOldKey.prefix,
      expiresAt: updatedOldKey.expiresAt!,
      rotatedAt: updatedOldKey.rotatedAt!,
      status: "rotating",
    },
    newKey: {
      id: newKey.id,
      name: newKey.name,
      prefix: newKey.prefix,
      scopes: newKey.scopes,
      key: rawKey,
      rotatedFromId: oldKey.id,
      createdAt: newKey.createdAt,
    },
    overlapExpiresAt,
    overlapWindowMs: windowMs,
  };
}

/**
 * Explicitly confirm rotation cutover: expires the old key immediately
 * so only the replacement key authenticates.
 */
export async function confirmApiKeyRotation(
  userId: string,
  keyId: string
): Promise<ConfirmRotationResult> {
  if (!keyId || typeof keyId !== "string") {
    throw new Error("Key ID is required");
  }

  // Look up key by ID
  const key = await prisma.apiKey.findFirst({
    where: { id: keyId, userId },
    include: {
      rotations: { orderBy: { createdAt: "desc" }, take: 1 },
      rotatedFrom: true,
    },
  });

  if (!key) {
    throw new Error("Key not found");
  }

  let oldKeyId: string;
  let replacementKeyId: string | undefined;

  if (key.rotatedAt) {
    // This is the parent key being rotated
    oldKeyId = key.id;
    replacementKeyId = key.rotations[0]?.id;
  } else if (key.rotatedFromId) {
    // This is the child/replacement key
    oldKeyId = key.rotatedFromId;
    replacementKeyId = key.id;
  } else {
    throw new Error("This key is not undergoing rotation");
  }

  // Set the old key's expiration to immediate past
  const expiredDate = new Date(Date.now() - 1000);
  await prisma.apiKey.update({
    where: { id: oldKeyId },
    data: { expiresAt: expiredDate },
  });

  try {
    await prisma.auditLog.create({
      data: {
        action: "api_key:rotate_confirm",
        actor: userId,
        target: oldKeyId,
        details: {
          oldKeyId,
          replacementKeyId,
          expiredAt: expiredDate.toISOString(),
        },
      },
    });
  } catch (err) {
    logger.warn("Failed to create audit log for api_key:rotate_confirm", { error: String(err) });
  }

  recordAudit({
    action: AUDIT_ACTIONS.API_KEY_ROTATE_CONFIRM,
    actor: userId,
    target: oldKeyId,
    details: { replacementKeyId },
  });

  logger.info("API key rotation confirmed early", {
    oldKeyId,
    replacementKeyId,
  });

  await invalidateCache("audit-log").catch(() => {});

  return {
    confirmed: true,
    expiredKeyId: oldKeyId,
    replacementKeyId,
  };
}

/**
 * Explicitly cancel rotation: rolls back the rotation by revoking/deleting the replacement key
 * and restoring the old key's pre-rotation state and expiration.
 */
export async function cancelApiKeyRotation(
  userId: string,
  keyId: string
): Promise<CancelRotationResult> {
  if (!keyId || typeof keyId !== "string") {
    throw new Error("Key ID is required");
  }

  const key = await prisma.apiKey.findFirst({
    where: { id: keyId, userId },
    include: {
      rotations: { orderBy: { createdAt: "desc" }, take: 1 },
      rotatedFrom: true,
    },
  });

  if (!key) {
    throw new Error("Key not found");
  }

  let oldKey: { id: string; preRotationExpiresAt: Date | null };
  let newKey: { id: string; name: string; prefix: string } | undefined;

  if (key.rotatedAt) {
    // key is the old key
    oldKey = {
      id: key.id,
      preRotationExpiresAt: key.preRotationExpiresAt,
    };
    newKey = key.rotations[0];
  } else if (key.rotatedFromId && key.rotatedFrom) {
    // key is the replacement key
    oldKey = {
      id: key.rotatedFrom.id,
      preRotationExpiresAt: key.rotatedFrom.preRotationExpiresAt,
    };
    newKey = key;
  } else {
    throw new Error("No active rotation found to cancel");
  }

  if (!newKey) {
    throw new Error("No replacement key found for this rotation");
  }

  const restoredExpiresAt = oldKey.preRotationExpiresAt ?? null;

  await prisma.$transaction([
    prisma.apiKey.delete({
      where: { id: newKey.id },
    }),
    prisma.apiKey.update({
      where: { id: oldKey.id },
      data: {
        rotatedAt: null,
        expiresAt: restoredExpiresAt,
        preRotationExpiresAt: null,
      },
    }),
  ]);

  try {
    await prisma.auditLog.create({
      data: {
        action: "api_key:rotate_cancel",
        actor: userId,
        target: oldKey.id,
        details: {
          restoredKeyId: oldKey.id,
          revokedKeyId: newKey.id,
          restoredExpiresAt: restoredExpiresAt?.toISOString() ?? null,
        },
      },
    });
  } catch (err) {
    logger.warn("Failed to create audit log for api_key:rotate_cancel", { error: String(err) });
  }

  recordAudit({
    action: AUDIT_ACTIONS.API_KEY_ROTATE_CANCEL,
    actor: userId,
    target: oldKey.id,
    details: { revokedKeyId: newKey.id },
  });

  logger.info("API key rotation cancelled", {
    restoredKeyId: oldKey.id,
    revokedKeyId: newKey.id,
  });

  await invalidateCache("audit-log").catch(() => {});

  return {
    cancelled: true,
    restoredKeyId: oldKey.id,
    revokedKeyId: newKey.id,
  };
}
