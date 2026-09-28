// SPDX-License-Identifier: MIT

/**
 * XLM / USD Price Utility & Conversion Service.
 *
 * Provides live spot pricing for Stellar Lumens (XLM) to USD with:
 * - Multi-source failover between price oracles (CoinGecko -> Coinbase)
 * - In-memory TTL caching with Stale-While-Revalidate (SWR) policy
 * - Rate-limit (HTTP 429) backoff and cooldown tracking (with Retry-After parsing)
 * - Staleness tracking and explicit staleness markers (isStale, staleReason, staleAgeMs)
 * - Configurable provider API key support (preventing anonymous tier throttling)
 * - Request deduplication and timeout protection
 * - Documented precision/rounding rules and asset unit fallbacks
 *
 * ## Rounding Rules Specification:
 * 1. Standard USD Amounts (>= $0.01):
 *    - Formatted using standard currency formatting with 2 decimal places (e.g. "$12.34").
 *    - Standard half-up financial rounding applied via Intl.NumberFormat.
 * 2. Micro Amounts (0 < amount < $0.01):
 *    - Formatted as "<$0.01" to avoid misleading zero display when value exists,
 *      or optionally up to 4 decimals (e.g. "$0.0045") if precision is requested.
 * 3. Zero Amounts (amount === 0):
 *    - Formatted as "$0.00".
 * 4. XLM Amounts:
 *    - 2 to 7 decimal places (1 XLM = 10,000,000 stroops).
 * 5. Unavailable / Error Fallback:
 *    - When price source is unreachable, returns null / "Unavailable" / fallback string.
 */

import { getPriceTimeoutMs } from "./timeout";

export const PRICE_CACHE_TTL_MS = 60_000; // 60 seconds
export const PRICE_STALE_THRESHOLD_MS = 300_000; // 5 minutes
/** Default when `PRICE_REQUEST_TIMEOUT_MS` is unset (see `lib/timeout.ts`). */
export const DEFAULT_PRICE_TIMEOUT_MS = 5_000; // 5 seconds
export const PRICE_BACKOFF_MS = 30_000; // 30 seconds
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000; // 30 seconds

export const ROUNDING_RULES = {
  USD_STANDARD_DECIMALS: 2,
  USD_MICRO_DECIMALS: 4,
  MICRO_THRESHOLD: 0.01,
  XLM_MIN_DECIMALS: 2,
  XLM_MAX_DECIMALS: 7,
} as const;

export type PriceStaleReason =
  | "expired"
  | "rate_limited"
  | "upstream_error"
  | (string & {});

export interface PriceResult {
  price: number | null;
  source: "coingecko" | "coinbase" | "cached" | null;
  error?: string;
  timestamp?: number;
  isStale?: boolean;
  staleAgeMs?: number;
  staleReason?: string;
  rateLimited?: boolean;
  rateLimitedUntil?: number;
}

export interface FetchXlmPriceOptions {
  forceRefresh?: boolean;
  ttlMs?: number;
  staleThresholdMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  apiKey?: string;
}

interface CacheEntry {
  price: number;
  source: "coingecko" | "coinbase";
  timestamp: number;
}

interface RateLimitState {
  coingeckoUntil: number;
  coinbaseUntil: number;
}

let priceCache: CacheEntry | null = null;
let pendingPriceFetch: Promise<PriceResult> | null = null;
let rateLimitState: RateLimitState = {
  coingeckoUntil: 0,
  coinbaseUntil: 0,
};

/**
 * Clear cached price and active pending fetch. Primarily for testing or manual cache busting.
 */
export function clearPriceCache(): void {
  priceCache = null;
  pendingPriceFetch = null;
}

/**
 * Clear rate limit cooldown state.
 */
export function clearRateLimitState(): void {
  rateLimitState = {
    coingeckoUntil: 0,
    coinbaseUntil: 0,
  };
}

/**
 * Set a manual cache entry (useful for testing or SSR bootstrapping).
 */
export function setCachedPrice(
  price: number,
  source: "coingecko" | "coinbase" = "coingecko",
  timestamp: number = Date.now()
): void {
  priceCache = {
    price,
    source,
    timestamp,
  };
}

/**
 * Parse Retry-After header value into cooldown milliseconds.
 * Supports numeric seconds ("60") or HTTP-date format ("Wed, 21 Oct 2026 07:28:00 GMT").
 */
export function parseRetryAfter(header: string | null | undefined): number {
  if (!header) return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(header);
  if (!isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.max(0, diff);
  }
  return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

/**
 * Check if an oracle source is currently in rate-limit cooldown.
 */
export function isSourceRateLimited(source: "coingecko" | "coinbase"): boolean {
  const until = source === "coingecko" ? rateLimitState.coingeckoUntil : rateLimitState.coinbaseUntil;
  return Date.now() < until;
}

/**
 * Resolve configured price provider API key from environment variables.
 */
export function getPriceProviderApiKey(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_PRICE_PROVIDER_API_KEY ||
    process.env.NEXT_PUBLIC_COINGECKO_API_KEY ||
    process.env.COINGECKO_API_KEY ||
    process.env.PRICE_API_KEY
  );
}

/**
 * Fetch current XLM spot price in USD with automatic multi-source fallback,
 * SWR caching, 429 backoff handling, and staleness markers.
 *
 * Source priority:
 * 1. CoinGecko Simple Price API
 * 2. Coinbase Spot Price API
 */
export async function fetchXlmPrice(options?: FetchXlmPriceOptions): Promise<PriceResult> {
  const ttl = options?.ttlMs ?? PRICE_CACHE_TTL_MS;
  const staleThreshold = options?.staleThresholdMs ?? PRICE_STALE_THRESHOLD_MS;
  const timeoutMs = options?.timeoutMs ?? getPriceTimeoutMs();
  const now = Date.now();

  // 1. Check in-memory cache
  if (!options?.forceRefresh && priceCache) {
    const age = now - priceCache.timestamp;

    // Within fresh TTL: serve directly
    if (age < ttl) {
      return {
        price: priceCache.price,
        source: "cached",
        timestamp: priceCache.timestamp,
        isStale: false,
        staleAgeMs: age,
        rateLimited: false,
      };
    }

    // Between TTL and stale threshold (SWR window): serve cached immediately and revalidate in background
    if (age < staleThreshold) {
      void triggerBackgroundRevalidation(options);
      return {
        price: priceCache.price,
        source: "cached",
        timestamp: priceCache.timestamp,
        isStale: false,
        staleAgeMs: age,
        rateLimited: false,
      };
    }
  }

  // 2. Deduplicate concurrent requests
  if (pendingPriceFetch && !options?.forceRefresh) {
    return pendingPriceFetch;
  }

  const fetchPromise = (async (): Promise<PriceResult> => {
    const currentNow = Date.now();
    let coingeckoRateLimited = currentNow < rateLimitState.coingeckoUntil;
    let coinbaseRateLimited = currentNow < rateLimitState.coinbaseUntil;

    // Both sources currently in cooldown
    if (coingeckoRateLimited && coinbaseRateLimited) {
      if (priceCache) {
        const age = currentNow - priceCache.timestamp;
        const isStale = age >= staleThreshold;
        return {
          price: priceCache.price,
          source: "cached",
          timestamp: priceCache.timestamp,
          isStale,
          staleAgeMs: age,
          staleReason: isStale
            ? `Cached price exceeds staleness threshold (${Math.round(age / 1000)}s old)`
            : undefined,
          rateLimited: true,
          rateLimitedUntil: Math.max(rateLimitState.coingeckoUntil, rateLimitState.coinbaseUntil),
          error: "All price providers in rate-limit cooldown, using cached price",
        };
      }
      return {
        price: null,
        source: null,
        isStale: false,
        rateLimited: true,
        rateLimitedUntil: Math.max(rateLimitState.coingeckoUntil, rateLimitState.coinbaseUntil),
        error: "All price providers in rate-limit cooldown and no cached price available",
      };
    }

    const apiKey = options?.apiKey || getPriceProviderApiKey();

    // ── Primary: CoinGecko ───────────────────────────────────
    if (!coingeckoRateLimited) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const combinedSignal = options?.signal
          ? anySignal([options.signal, controller.signal])
          : controller.signal;

        const headers: Record<string, string> = { Accept: "application/json" };
        if (apiKey) {
          headers["x-cg-demo-api-key"] = apiKey;
        }

        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd",
          {
            headers,
            signal: combinedSignal,
          }
        );

        if (res.status === 429) {
          const retryAfter = res.headers?.get?.("retry-after") ?? res.headers?.get?.("Retry-After");
          const cooldownMs = parseRetryAfter(retryAfter);
          rateLimitState.coingeckoUntil = Date.now() + cooldownMs;
          coingeckoRateLimited = true;
        } else if (res.ok) {
          const data = await res.json();
          const price = data?.stellar?.usd;
          if (typeof price === "number" && !isNaN(price) && price > 0) {
            priceCache = { price, source: "coingecko", timestamp: Date.now() };
            return {
              price,
              source: "coingecko",
              timestamp: priceCache.timestamp,
              isStale: false,
              staleAgeMs: 0,
              rateLimited: false,
            };
          }
        }
      } catch {
        // Fall through to secondary source
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }

    // ── Secondary: Coinbase ──────────────────────────────────
    if (!coinbaseRateLimited) {
      let secondaryTimeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const controller = new AbortController();
        secondaryTimeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const combinedSignal = options?.signal
          ? anySignal([options.signal, controller.signal])
          : controller.signal;

        const headers: Record<string, string> = { Accept: "application/json" };

        const res = await fetch("https://api.coinbase.com/v2/prices/XLM-USD/spot", {
          headers,
          signal: combinedSignal,
        });

        if (res.status === 429) {
          const retryAfter = res.headers?.get?.("retry-after") ?? res.headers?.get?.("Retry-After");
          const cooldownMs = parseRetryAfter(retryAfter);
          rateLimitState.coinbaseUntil = Date.now() + cooldownMs;
          coinbaseRateLimited = true;
        } else if (res.ok) {
          const data = await res.json();
          const priceStr = data?.data?.amount;
          const price = typeof priceStr === "string" ? parseFloat(priceStr) : Number(priceStr);
          if (typeof price === "number" && !isNaN(price) && price > 0) {
            priceCache = { price, source: "coinbase", timestamp: Date.now() };
            return {
              price,
              source: "coinbase",
              timestamp: priceCache.timestamp,
              isStale: false,
              staleAgeMs: 0,
              rateLimited: false,
            };
          }
        }
      } catch {
        // All sources failed
      } finally {
        if (secondaryTimeoutId) {
          clearTimeout(secondaryTimeoutId);
        }
      }
    }

    // ── Upstream Failure / Rate-Limited Fallback ─────────────
    if (priceCache) {
      const age = Date.now() - priceCache.timestamp;
      const isStale = age >= staleThreshold;
      const wasRateLimited = coingeckoRateLimited || coinbaseRateLimited;

      return {
        price: priceCache.price,
        source: "cached",
        timestamp: priceCache.timestamp,
        isStale,
        staleAgeMs: age,
        staleReason: isStale
          ? `Price sources ${wasRateLimited ? "rate-limited" : "unreachable"}; cached price is ${Math.round(age / 1000)}s old (exceeds ${Math.round(staleThreshold / 1000)}s threshold)`
          : undefined,
        rateLimited: wasRateLimited,
        error: wasRateLimited
          ? "Price sources currently rate-limited, using last known price"
          : "Price sources currently unreachable, using last known price",
      };
    }

    return {
      price: null,
      source: null,
      isStale: false,
      rateLimited: coingeckoRateLimited || coinbaseRateLimited,
      error: coingeckoRateLimited || coinbaseRateLimited
        ? "XLM/USD price sources rate-limited and unavailable"
        : "XLM/USD price sources unavailable",
    };
  })();

  pendingPriceFetch = fetchPromise;
  try {
    return await fetchPromise;
  } finally {
    pendingPriceFetch = null;
  }
}

/**
 * Trigger background revalidation for SWR cache entries.
 */
function triggerBackgroundRevalidation(options?: FetchXlmPriceOptions): void {
  if (pendingPriceFetch) return;
  void fetchXlmPrice({
    ...options,
    forceRefresh: true,
  }).catch(() => {
    // Background revalidation failures are silent; existing cache remains untouched
  });
}

/**
 * Convert an XLM amount to USD using the given exchange rate.
 */
export function convertXlmToUsd(
  xlmAmount: number | string,
  pricePerXlm: number | null | undefined
): number | null {
  if (pricePerXlm === null || pricePerXlm === undefined || isNaN(pricePerXlm) || pricePerXlm <= 0) {
    return null;
  }
  const xlm = typeof xlmAmount === "string" ? parseFloat(xlmAmount) : xlmAmount;
  if (isNaN(xlm)) return null;

  return xlm * pricePerXlm;
}

export interface FormatFiatOptions {
  showApprox?: boolean;
  fallback?: string;
  minDecimals?: number;
  maxDecimals?: number;
  allowMicro?: boolean;
}

/**
 * Format a USD number according to documented OphirPay rounding rules.
 *
 * @example
 * formatFiatAmount(12.3456) => "$12.35"
 * formatFiatAmount(12.3456, { showApprox: true }) => "~$12.35"
 * formatFiatAmount(0.004) => "<$0.01"
 * formatFiatAmount(0.004, { allowMicro: true }) => "$0.0040"
 * formatFiatAmount(null) => "—"
 */
export function formatFiatAmount(
  usdAmount: number | null | undefined,
  options?: FormatFiatOptions
): string {
  const fallback = options?.fallback ?? "—";
  if (usdAmount === null || usdAmount === undefined || isNaN(usdAmount)) {
    return fallback;
  }

  const prefix = options?.showApprox ? "~" : "";

  // Exact zero
  if (usdAmount === 0) {
    return `${prefix}$0.00`;
  }

  const absAmount = Math.abs(usdAmount);

  // Micro amounts between 0 and 0.01
  if (absAmount > 0 && absAmount < ROUNDING_RULES.MICRO_THRESHOLD) {
    if (options?.allowMicro) {
      const formatted = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: options.minDecimals ?? ROUNDING_RULES.USD_MICRO_DECIMALS,
        maximumFractionDigits: options.maxDecimals ?? ROUNDING_RULES.USD_MICRO_DECIMALS,
      }).format(usdAmount);
      return `${prefix}${formatted}`;
    }
    const sign = usdAmount < 0 ? "-" : "";
    return `${prefix}${sign}<$0.01`;
  }

  // Standard USD formatting
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: options?.minDecimals ?? ROUNDING_RULES.USD_STANDARD_DECIMALS,
    maximumFractionDigits: options?.maxDecimals ?? ROUNDING_RULES.USD_STANDARD_DECIMALS,
  }).format(usdAmount);

  return `${prefix}${formatted}`;
}

export interface FormatPriceOrAssetOptions extends FormatFiatOptions {
  assetUnit?: string;
  staleThresholdMs?: number;
}

export interface FormattedPriceOrAsset {
  display: string;
  formatted: string;
  isFallback: boolean;
  isStale: boolean;
  isFiat: boolean;
  amount: number | null;
}

/**
 * Format a balance or payment amount, displaying formatted fiat if fresh price is available,
 * or gracefully falling back to displaying the asset unit (e.g. "10.00 XLM (USD price unavailable)"
 * or "10.00 XLM (USD price stale)") when the price is stale or unavailable.
 */
export function formatPriceOrAsset(
  amount: number | string,
  priceResult: Pick<PriceResult, "price" | "isStale" | "timestamp"> | null | undefined,
  options?: FormatPriceOrAssetOptions
): FormattedPriceOrAsset {
  const assetUnit = options?.assetUnit ?? "XLM";
  const staleThreshold = options?.staleThresholdMs ?? PRICE_STALE_THRESHOLD_MS;
  const numAmount = typeof amount === "string" ? parseFloat(amount) : amount;

  if (isNaN(numAmount)) {
    const fallbackStr = `— ${assetUnit}`;
    return {
      display: fallbackStr,
      formatted: fallbackStr,
      isFallback: true,
      isStale: false,
      isFiat: false,
      amount: null,
    };
  }

  const isPastTimeThreshold = Boolean(
    priceResult?.timestamp && Date.now() - priceResult.timestamp >= staleThreshold
  );
  const isStale = Boolean(
    priceResult?.isStale || isPastTimeThreshold
  );
  const isUnavailable = !priceResult || priceResult.price === null || priceResult.price === undefined;

  if (isUnavailable || isStale) {
    const formattedAsset = `${numAmount.toFixed(2)} ${assetUnit}`;
    const indicator = isUnavailable
      ? "(USD price unavailable)"
      : "(USD price stale)";
    const displayStr = `${formattedAsset} ${indicator}`;
    return {
      display: displayStr,
      formatted: displayStr,
      isFallback: true,
      isStale: true,
      isFiat: false,
      amount: numAmount,
    };
  }

  const usdVal = convertXlmToUsd(numAmount, priceResult.price);
  const formattedFiat = formatFiatAmount(usdVal, {
    showApprox: options?.showApprox ?? (options?.showApprox !== false),
    ...options,
  });
  return {
    display: formattedFiat,
    formatted: formattedFiat,
    isFallback: false,
    isStale: false,
    isFiat: true,
    amount: usdVal,
  };
}

/**
 * Fallback helper when price is unavailable or stale.
 */
export function formatPriceUnavailableFallback(
  xlmAmount: number | string,
  result: Pick<PriceResult, "price" | "isStale"> | null | undefined,
  assetUnit = "XLM"
): string | null {
  if (result?.price !== null && result?.price !== undefined && !result.isStale) {
    return null;
  }
  const amount = typeof xlmAmount === "string" ? xlmAmount : xlmAmount.toString();
  const reason = result?.price !== null && result?.price !== undefined && result?.isStale ? "stale" : "unavailable";
  return `${amount} ${assetUnit} (USD price ${reason})`;
}

/**
 * Helper to combine abort signals across environments.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return signal;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}
