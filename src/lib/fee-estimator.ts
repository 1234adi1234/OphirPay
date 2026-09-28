// SPDX-License-Identifier: MIT

import { getHorizonServer } from "@/lib/stellar";

export type FeePolicy = "low" | "normal" | "high" | "priority";
export type NetworkCongestion = "low" | "medium" | "high";
export type FeeBasis = "live" | "cached" | "configured";

/** Standard Stellar network base fee in stroops (0.00001 XLM). */
export const DEFAULT_BASE_FEE = 100;

/** Default refresh/cache interval for Horizon fee statistics (15 seconds). */
export const FEE_STATS_REFRESH_INTERVAL_MS = 15_000;

export interface HorizonFeeDistribution {
  min: number;
  mode: number;
  p10: number;
  p20: number;
  p30: number;
  p40: number;
  p50: number;
  p60: number;
  p70: number;
  p80: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

export interface HorizonFeeStats {
  lastLedger: number;
  lastLedgerBaseFee: number;
  ledgerCapacityUsage: number;
  feeCharged: HorizonFeeDistribution;
  maxFee?: HorizonFeeDistribution;
}

export interface FeeEstimate {
  baseFee: string;
  estimatedFee: string;
  operations: number;
  networkCongestion: NetworkCongestion;
  congestion: NetworkCongestion;
  basis: FeeBasis;
  isFallback: boolean;
  policy: FeePolicy;
  ledgerCapacityUsage?: number;
  explanation?: string;
  lastUpdated?: number;
}

export interface EstimateFeeOptions {
  operations?: number;
  policy?: FeePolicy;
  forceRefresh?: boolean;
  configuredBaseFee?: number;
}

interface CachedFeeStats {
  stats: HorizonFeeStats;
  timestamp: number;
}

let lastKnownGoodStats: CachedFeeStats | null = null;

/**
 * Reset the in-memory fee stats cache (primarily for testing).
 */
export function clearFeeStatsCache(): void {
  lastKnownGoodStats = null;
}

/**
 * Explicitly set cached fee stats (primarily for testing).
 */
export function setCachedFeeStats(stats: HorizonFeeStats, timestamp = Date.now()): void {
  lastKnownGoodStats = { stats, timestamp };
}

/**
 * Retrieve the current cached fee statistics, if any.
 */
export function getCachedFeeStats(): HorizonFeeStats | null {
  return lastKnownGoodStats ? { ...lastKnownGoodStats.stats } : null;
}

/**
 * Parse an untyped distribution object safely into numbers.
 */
function parseDistribution(raw: unknown, defaultVal: number): HorizonFeeDistribution {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown): number => {
    if (typeof v === "number" && !isNaN(v)) return v;
    if (typeof v === "string") {
      const parsed = parseFloat(v);
      if (!isNaN(parsed)) return parsed;
    }
    return defaultVal;
  };

  return {
    min: num(d.min),
    mode: num(d.mode),
    p10: num(d.p10),
    p20: num(d.p20),
    p30: num(d.p30),
    p40: num(d.p40),
    p50: num(d.p50),
    p60: num(d.p60),
    p70: num(d.p70),
    p80: num(d.p80),
    p90: num(d.p90),
    p95: num(d.p95),
    p99: num(d.p99),
    max: num(d.max),
  };
}

/**
 * Parse raw Horizon /fee_stats response into structured numbers with fallback defaults.
 */
export function parseHorizonFeeStats(raw: unknown): HorizonFeeStats {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Horizon fee stats response");
  }

  const obj = raw as Record<string, unknown>;

  const lastLedger = typeof obj.last_ledger === "number"
    ? obj.last_ledger
    : parseInt(String(obj.last_ledger ?? obj.lastLedger ?? "0"), 10) || 0;

  const baseFeeRaw = obj.last_ledger_base_fee ?? obj.lastLedgerBaseFee ?? DEFAULT_BASE_FEE;
  const lastLedgerBaseFee = typeof baseFeeRaw === "number"
    ? baseFeeRaw
    : parseInt(String(baseFeeRaw), 10) || DEFAULT_BASE_FEE;

  const usageRaw = obj.ledger_capacity_usage ?? obj.ledgerCapacityUsage ?? "0";
  const ledgerCapacityUsage = typeof usageRaw === "number"
    ? usageRaw
    : parseFloat(String(usageRaw)) || 0;

  const feeCharged = parseDistribution(obj.fee_charged ?? obj.feeCharged, lastLedgerBaseFee);
  const maxFee = (obj.max_fee || obj.maxFee)
    ? parseDistribution(obj.max_fee ?? obj.maxFee, lastLedgerBaseFee)
    : undefined;

  return {
    lastLedger,
    lastLedgerBaseFee,
    ledgerCapacityUsage,
    feeCharged,
    maxFee,
  };
}

/**
 * Classify network congestion level from capacity usage and fee metrics.
 */
export function calculateNetworkCongestion(
  capacityUsage: number,
  baseFee: number,
  p50Fee: number
): NetworkCongestion {
  if (capacityUsage >= 0.85 || p50Fee > 200 || baseFee > 200) {
    return "high";
  }
  if (capacityUsage >= 0.5 || p50Fee > 100 || baseFee > 100) {
    return "medium";
  }
  return "low";
}

/**
 * Recommend a base fee per operation (in stroops) according to policy and network stats.
 */
export function recommendBaseFee(
  stats: HorizonFeeStats,
  policy: FeePolicy = "normal",
  configuredFloor = DEFAULT_BASE_FEE
): number {
  const floor = Math.max(configuredFloor, stats.lastLedgerBaseFee);

  switch (policy) {
    case "low":
      // Economy policy: use 10th percentile or mode, floored by network base fee
      return Math.max(floor, stats.feeCharged.p10 || stats.feeCharged.min);

    case "high":
      // High urgency policy: use 90th percentile to clear congestion
      return Math.max(floor, stats.feeCharged.p90);

    case "priority":
      // Priority policy: 95th percentile or p90 with congestion buffer
      return Math.max(floor, stats.feeCharged.p95 || stats.feeCharged.p90);

    case "normal":
    default:
      // Normal policy: median (50th percentile) fee charged
      return Math.max(floor, stats.feeCharged.p50 || stats.feeCharged.mode);
  }
}

/**
 * Generate human-readable explanation of why a fee was recommended.
 */
export function generateFeeExplanation(
  basis: FeeBasis,
  congestion: NetworkCongestion,
  capacityUsage: number,
  recommendedBaseFee: number,
  p50Fee: number
): string {
  if (basis === "cached") {
    return `Horizon is unreachable. Using cached statistics from last known ledger (${recommendedBaseFee} stroops/op).`;
  }
  if (basis === "configured") {
    return `Horizon is unreachable. Using configured network base fee (${recommendedBaseFee} stroops/op).`;
  }

  const usagePercent = Math.round(capacityUsage * 100);
  if (congestion === "high") {
    return `High network congestion (ledger capacity: ${usagePercent}%, median fee: ${p50Fee} stroops). Fee bumped to ensure prompt confirmation.`;
  }
  if (congestion === "medium") {
    return `Moderate network activity (ledger capacity: ${usagePercent}%, median fee: ${p50Fee} stroops).`;
  }
  return `Normal network conditions (ledger capacity: ${usagePercent}%, base fee: ${recommendedBaseFee} stroops).`;
}

/**
 * Fetch or retrieve cached Horizon fee statistics with fallback handling.
 */
async function getOrFetchFeeStats(
  forceRefresh = false,
  configuredBaseFee = DEFAULT_BASE_FEE
): Promise<{ stats: HorizonFeeStats; basis: FeeBasis; isFallback: boolean }> {
  const now = Date.now();

  // Return cached live statistics if still fresh
  if (!forceRefresh && lastKnownGoodStats && now - lastKnownGoodStats.timestamp < FEE_STATS_REFRESH_INTERVAL_MS) {
    return {
      stats: lastKnownGoodStats.stats,
      basis: "live",
      isFallback: false,
    };
  }

  try {
    const server = getHorizonServer();

    // Check if server supports feeStats()
    if (typeof (server as unknown as { feeStats?: () => Promise<unknown> }).feeStats === "function") {
      const raw = await (server as unknown as { feeStats: () => Promise<unknown> }).feeStats();
      const stats = parseHorizonFeeStats(raw);
      lastKnownGoodStats = { stats, timestamp: now };
      return { stats, basis: "live", isFallback: false };
    }

    // Fallback for test environments or older SDK servers that only mock fetchBaseFee()
    if (typeof server.fetchBaseFee === "function") {
      const baseFeeResponse = await server.fetchBaseFee();
      const baseFee = parseFloat(baseFeeResponse.toString()) || configuredBaseFee;
      const stats: HorizonFeeStats = {
        lastLedger: 0,
        lastLedgerBaseFee: baseFee,
        ledgerCapacityUsage: 0,
        feeCharged: parseDistribution({}, baseFee),
      };
      return { stats, basis: "live", isFallback: false };
    }

    throw new Error("Horizon server does not provide fee statistics methods");
  } catch {
    // Horizon is unreachable: fallback to last known good cached stats
    if (lastKnownGoodStats) {
      return {
        stats: lastKnownGoodStats.stats,
        basis: "cached",
        isFallback: true,
      };
    }

    // If no cached stats exist, fallback to configured base fee
    const fallbackStats: HorizonFeeStats = {
      lastLedger: 0,
      lastLedgerBaseFee: configuredBaseFee,
      ledgerCapacityUsage: 0,
      feeCharged: parseDistribution({}, configuredBaseFee),
    };

    return {
      stats: fallbackStats,
      basis: "configured",
      isFallback: true,
    };
  }
}

/**
 * Recommend transaction fee derived dynamically from Horizon fee statistics,
 * supporting configurable aggressiveness policies and fallback when Horizon is unreachable.
 */
export async function recommendTransactionFee(
  options: EstimateFeeOptions = {}
): Promise<FeeEstimate> {
  const operations = Math.max(1, options.operations ?? 1);
  const policy = options.policy ?? "normal";
  const configuredBaseFee = options.configuredBaseFee ?? DEFAULT_BASE_FEE;

  const { stats, basis, isFallback } = await getOrFetchFeeStats(
    options.forceRefresh ?? false,
    configuredBaseFee
  );

  const baseFee = recommendBaseFee(stats, policy, configuredBaseFee);
  const totalFee = baseFee * operations;
  const congestion = calculateNetworkCongestion(
    stats.ledgerCapacityUsage,
    baseFee,
    stats.feeCharged.p50
  );

  const explanation = generateFeeExplanation(
    basis,
    congestion,
    stats.ledgerCapacityUsage,
    baseFee,
    stats.feeCharged.p50
  );

  return {
    baseFee: baseFee.toString(),
    estimatedFee: totalFee.toString(),
    operations,
    networkCongestion: congestion,
    congestion,
    basis,
    isFallback,
    policy,
    ledgerCapacityUsage: stats.ledgerCapacityUsage,
    explanation,
    lastUpdated: lastKnownGoodStats?.timestamp,
  };
}

/**
 * Estimate the fee for a Stellar transaction based on Horizon fee statistics
 * and the number of operations.
 *
 * Fully backward-compatible with the original signature while providing
 * dynamic recommendation from live Horizon fee statistics.
 */
export async function estimateTransactionFee(
  numOperations = 1,
  policy: FeePolicy = "normal"
): Promise<FeeEstimate> {
  return recommendTransactionFee({
    operations: numOperations,
    policy,
  });
}

/**
 * Calculate the estimated total fee for a batch payment with N recipients.
 * Each recipient = 1 payment operation.
 */
export function estimateBatchFee(
  recipientCount: number,
  baseFee: number | string = DEFAULT_BASE_FEE
): string {
  const feeNum = typeof baseFee === "number" ? baseFee : parseFloat(baseFee) || DEFAULT_BASE_FEE;
  return (feeNum * recipientCount).toString();
}
