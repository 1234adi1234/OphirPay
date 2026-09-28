import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, Account, Horizon, TransactionBuilder } from "@stellar/stellar-sdk";
import * as stellarLib from "@/lib/stellar";
import {
  parseHorizonFeeStats,
  recommendBaseFee,
  calculateNetworkCongestion,
  generateFeeExplanation,
  recommendTransactionFee,
  estimateTransactionFee,
  estimateBatchFee,
  clearFeeStatsCache,
  setCachedFeeStats,
  getCachedFeeStats,
  DEFAULT_BASE_FEE,
  FEE_STATS_REFRESH_INTERVAL_MS,
  type HorizonFeeStats,
} from "@/lib/fee-estimator";

const mockFeeStatsPayload = {
  last_ledger: "501234",
  last_ledger_base_fee: "100",
  ledger_capacity_usage: "0.25",
  fee_charged: {
    min: "100",
    mode: "100",
    p10: "100",
    p20: "100",
    p30: "100",
    p40: "100",
    p50: "150",
    p60: "180",
    p70: "200",
    p80: "250",
    p90: "300",
    p95: "400",
    p99: "500",
    max: "1000",
  },
  max_fee: {
    min: "100",
    mode: "100",
    p10: "100",
    p20: "100",
    p30: "100",
    p40: "100",
    p50: "200",
    p60: "250",
    p70: "300",
    p80: "400",
    p90: "500",
    p95: "600",
    p99: "1000",
    max: "2000",
  },
};

describe("Fee Estimator - Horizon Statistics Parsing", () => {
  beforeEach(() => {
    clearFeeStatsCache();
    vi.restoreAllMocks();
  });

  it("parses valid Horizon fee_stats response correctly", () => {
    const parsed = parseHorizonFeeStats(mockFeeStatsPayload);

    expect(parsed.lastLedger).toBe(501234);
    expect(parsed.lastLedgerBaseFee).toBe(100);
    expect(parsed.ledgerCapacityUsage).toBe(0.25);
    expect(parsed.feeCharged.min).toBe(100);
    expect(parsed.feeCharged.p10).toBe(100);
    expect(parsed.feeCharged.p50).toBe(150);
    expect(parsed.feeCharged.p90).toBe(300);
    expect(parsed.feeCharged.p95).toBe(400);
    expect(parsed.feeCharged.max).toBe(1000);
    expect(parsed.maxFee?.p50).toBe(200);
  });

  it("handles numeric values and camelCase formats", () => {
    const raw = {
      lastLedger: 600000,
      lastLedgerBaseFee: 120,
      ledgerCapacityUsage: 0.75,
      feeCharged: {
        min: 120,
        mode: 120,
        p10: 120,
        p20: 120,
        p30: 120,
        p40: 130,
        p50: 160,
        p60: 180,
        p70: 210,
        p80: 260,
        p90: 350,
        p95: 450,
        p99: 600,
        max: 1200,
      },
    };

    const parsed = parseHorizonFeeStats(raw);
    expect(parsed.lastLedger).toBe(600000);
    expect(parsed.lastLedgerBaseFee).toBe(120);
    expect(parsed.ledgerCapacityUsage).toBe(0.75);
    expect(parsed.feeCharged.p50).toBe(160);
  });

  it("safely fills in defaults when fields are missing or invalid", () => {
    const partial = {
      last_ledger: "invalid",
      fee_charged: {
        p50: "not_a_number",
      },
    };

    const parsed = parseHorizonFeeStats(partial);
    expect(parsed.lastLedger).toBe(0);
    expect(parsed.lastLedgerBaseFee).toBe(DEFAULT_BASE_FEE);
    expect(parsed.ledgerCapacityUsage).toBe(0);
    expect(parsed.feeCharged.p50).toBe(DEFAULT_BASE_FEE);
    expect(parsed.feeCharged.min).toBe(DEFAULT_BASE_FEE);
  });

  it("throws on non-object inputs", () => {
    expect(() => parseHorizonFeeStats(null)).toThrow("Invalid Horizon fee stats response");
    expect(() => parseHorizonFeeStats("invalid")).toThrow("Invalid Horizon fee stats response");
  });
});

describe("Fee Estimator - Aggressiveness Policies", () => {
  const sampleStats: HorizonFeeStats = {
    lastLedger: 100,
    lastLedgerBaseFee: 100,
    ledgerCapacityUsage: 0.4,
    feeCharged: {
      min: 100,
      mode: 100,
      p10: 105,
      p20: 110,
      p30: 120,
      p40: 130,
      p50: 175,
      p60: 200,
      p70: 230,
      p80: 270,
      p90: 350,
      p95: 450,
      p99: 600,
      max: 1000,
    },
  };

  it("recommends low policy based on p10", () => {
    const fee = recommendBaseFee(sampleStats, "low");
    expect(fee).toBe(105);
  });

  it("recommends normal policy based on p50", () => {
    const fee = recommendBaseFee(sampleStats, "normal");
    expect(fee).toBe(175);
  });

  it("recommends high policy based on p90", () => {
    const fee = recommendBaseFee(sampleStats, "high");
    expect(fee).toBe(350);
  });

  it("recommends priority policy based on p95", () => {
    const fee = recommendBaseFee(sampleStats, "priority");
    expect(fee).toBe(450);
  });

  it("enforces minimum base fee floor of 100 stroops", () => {
    const lowStats: HorizonFeeStats = {
      ...sampleStats,
      lastLedgerBaseFee: 100,
      feeCharged: {
        ...sampleStats.feeCharged,
        p10: 50,
        p50: 80,
      },
    };

    expect(recommendBaseFee(lowStats, "low")).toBe(100);
    expect(recommendBaseFee(lowStats, "normal")).toBe(100);
  });

  it("respects higher lastLedgerBaseFee floor during network surges", () => {
    const surgedStats: HorizonFeeStats = {
      ...sampleStats,
      lastLedgerBaseFee: 250,
    };

    expect(recommendBaseFee(surgedStats, "low")).toBe(250);
    expect(recommendBaseFee(surgedStats, "normal")).toBe(250);
  });
});

describe("Fee Estimator - Congestion & Explanation", () => {
  it("classifies low, medium, and high congestion correctly", () => {
    expect(calculateNetworkCongestion(0.2, 100, 100)).toBe("low");
    expect(calculateNetworkCongestion(0.6, 100, 100)).toBe("medium");
    expect(calculateNetworkCongestion(0.2, 100, 150)).toBe("medium");
    expect(calculateNetworkCongestion(0.86, 100, 100)).toBe("high");
    expect(calculateNetworkCongestion(0.3, 100, 250)).toBe("high");
  });

  it("generates clear explanations for live, cached, and configured bases", () => {
    const liveNormal = generateFeeExplanation("live", "low", 0.15, 100, 100);
    expect(liveNormal).toContain("Normal network conditions");
    expect(liveNormal).toContain("15%");

    const liveHigh = generateFeeExplanation("live", "high", 0.92, 350, 300);
    expect(liveHigh).toContain("High network congestion");
    expect(liveHigh).toContain("92%");

    const cached = generateFeeExplanation("cached", "low", 0.1, 150, 150);
    expect(cached).toContain("Horizon is unreachable. Using cached statistics");

    const configured = generateFeeExplanation("configured", "low", 0, 100, 100);
    expect(configured).toContain("Horizon is unreachable. Using configured network base fee");
  });
});

describe("Fee Estimator - Caching and Refresh Interval", () => {
  beforeEach(() => {
    clearFeeStatsCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("caches live Horizon fee stats and respects refresh interval", async () => {
    const feeStatsMock = vi.fn().mockResolvedValue(mockFeeStatsPayload);
    vi.spyOn(stellarLib, "getHorizonServer").mockReturnValue({
      feeStats: feeStatsMock,
    } as never);

    // Initial fetch (cache miss)
    const first = await recommendTransactionFee({ policy: "normal" });
    expect(feeStatsMock).toHaveBeenCalledTimes(1);
    expect(first.basis).toBe("live");
    expect(first.isFallback).toBe(false);
    expect(first.baseFee).toBe("150");

    // Advance 5 seconds (< 15 seconds refresh interval)
    vi.advanceTimersByTime(5000);

    const second = await recommendTransactionFee({ policy: "normal" });
    expect(feeStatsMock).toHaveBeenCalledTimes(1); // Cached!
    expect(second.basis).toBe("live");
    expect(second.baseFee).toBe("150");

    // Advance past 15 seconds TTL
    vi.advanceTimersByTime(11000);

    const third = await recommendTransactionFee({ policy: "normal" });
    expect(feeStatsMock).toHaveBeenCalledTimes(2); // Refreshed!
    expect(third.basis).toBe("live");
  });

  it("forceRefresh bypasses the cache", async () => {
    const feeStatsMock = vi.fn().mockResolvedValue(mockFeeStatsPayload);
    vi.spyOn(stellarLib, "getHorizonServer").mockReturnValue({
      feeStats: feeStatsMock,
    } as never);

    await recommendTransactionFee();
    expect(feeStatsMock).toHaveBeenCalledTimes(1);

    await recommendTransactionFee({ forceRefresh: true });
    expect(feeStatsMock).toHaveBeenCalledTimes(2);
  });
});

describe("Fee Estimator - Fallback Handling", () => {
  beforeEach(() => {
    clearFeeStatsCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to last known good cached statistics when Horizon becomes unreachable", async () => {
    const stats: HorizonFeeStats = {
      lastLedger: 500000,
      lastLedgerBaseFee: 100,
      ledgerCapacityUsage: 0.8,
      feeCharged: {
        min: 100,
        mode: 100,
        p10: 100,
        p20: 120,
        p30: 130,
        p40: 140,
        p50: 220,
        p60: 240,
        p70: 260,
        p80: 280,
        p90: 350,
        p95: 450,
        p99: 600,
        max: 1000,
      },
    };

    setCachedFeeStats(stats, Date.now() - 60000); // 1 minute old cache

    // Horizon throws error
    vi.spyOn(stellarLib, "getHorizonServer").mockReturnValue({
      feeStats: vi.fn().mockRejectedValue(new Error("Horizon unreachable (503 Service Unavailable)")),
    } as never);

    const estimate = await recommendTransactionFee({ policy: "normal", forceRefresh: true });

    expect(estimate.basis).toBe("cached");
    expect(estimate.isFallback).toBe(true);
    expect(estimate.baseFee).toBe("220");
    expect(estimate.explanation).toContain("Horizon is unreachable. Using cached statistics");
  });

  it("falls back to configured network base fee when Horizon is unreachable and no cache exists", async () => {
    clearFeeStatsCache();

    vi.spyOn(stellarLib, "getHorizonServer").mockReturnValue({
      feeStats: vi.fn().mockRejectedValue(new Error("Network connection refused")),
    } as never);

    const estimate = await recommendTransactionFee({ policy: "normal" });

    expect(estimate.basis).toBe("configured");
    expect(estimate.isFallback).toBe(true);
    expect(estimate.baseFee).toBe("100");
    expect(estimate.estimatedFee).toBe("100");
    expect(estimate.explanation).toContain("configured network base fee");
  });

  it("handles servers that only provide fetchBaseFee (backward compatibility)", async () => {
    clearFeeStatsCache();

    vi.spyOn(stellarLib, "getHorizonServer").mockReturnValue({
      fetchBaseFee: vi.fn().mockResolvedValue(180),
    } as never);

    const estimate = await estimateTransactionFee(2, "normal");
    expect(estimate.basis).toBe("live");
    expect(estimate.baseFee).toBe("180");
    expect(estimate.estimatedFee).toBe("360");
    expect(estimate.networkCongestion).toBe("medium");
  });
});

describe("Fee Estimator - Batch Fee Calculation", () => {
  it("multiplies base fee by recipient count", () => {
    expect(estimateBatchFee(1, 100)).toBe("100");
    expect(estimateBatchFee(5, 100)).toBe("500");
    expect(estimateBatchFee(10, 250)).toBe("2500");
    expect(estimateBatchFee(3, "150")).toBe("450");
  });
});

describe("Fee Estimator - Exact Fee Matching in Transaction Builder", () => {
  const sourceKeyPair = Keypair.random().publicKey();
  const destKeyPair = Keypair.random().publicKey();

  beforeEach(() => {
    clearFeeStatsCache();
    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValue(
      new Account(sourceKeyPair, "123456") as unknown as any
    );
    vi.spyOn(Horizon.Server.prototype, "feeStats").mockResolvedValue(
      mockFeeStatsPayload as never
    );
    vi.spyOn(Horizon.Server.prototype, "fetchBaseFee").mockResolvedValue(100);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ensures buildPaymentTx fee matches recommended baseFee exactly", async () => {
    const recommended = await recommendTransactionFee({ policy: "high" });
    expect(recommended.baseFee).toBe("300");

    // Build transaction passing the recommended baseFee
    const { xdr } = await stellarLib.buildPaymentTx({
      sourcePublicKey: sourceKeyPair,
      destination: destKeyPair,
      amount: "10",
      baseFee: recommended.baseFee,
    });

    // Reconstruct transaction from XDR and inspect fee
    const tx = TransactionBuilder.fromXDR(xdr, stellarLib.NETWORK_PASSPHRASE);
    expect(tx.fee.toString()).toBe("300");
  });

  it("ensures buildBatchPaymentTx fee matches recommended baseFee * recipients", async () => {
    const recipientCount = 4;
    const recommended = await recommendTransactionFee({
      operations: recipientCount,
      policy: "normal",
    });

    expect(recommended.baseFee).toBe("150");
    expect(recommended.estimatedFee).toBe("600"); // 150 * 4

    const recipients = Array.from({ length: recipientCount }, () => ({
      address: Keypair.random().publicKey(),
      amount: "5",
    }));

    const { xdr } = await stellarLib.buildBatchPaymentTx({
      sourcePublicKey: sourceKeyPair,
      recipients,
      baseFee: recommended.baseFee,
    });

    const tx = TransactionBuilder.fromXDR(xdr, stellarLib.NETWORK_PASSPHRASE);
    // In Stellar, transaction.fee is baseFee * operationsCount
    expect(tx.fee.toString()).toBe("600");
    expect(tx.fee.toString()).toBe(recommended.estimatedFee);
  });
});
