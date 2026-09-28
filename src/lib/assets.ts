// SPDX-License-Identifier: MIT

/**
 * Multi-asset support for Stellar payments beyond native XLM.
 * Includes USDC on Stellar, custom token validation helpers, and
 * SEP-1 asset metadata discovery with TTL caching and safety limits.
 */

import { HORIZON_URL } from "@/lib/stellar";
import { isSafeWebhookUrl } from "@/lib/webhook-url-guard";
import { getMetadataTimeoutMs } from "@/lib/timeout";

export interface AssetInfo {
  code: string;
  issuer?: string;
  type: "native" | "credit_alphanum4" | "credit_alphanum12";
  displayName: string;
  decimals: number;
  domain?: string;
  orgName?: string;
  desc?: string;
  description?: string;
  name?: string;
  displayDecimals?: number;
  resolved?: boolean;
}

// ── Known Assets ───────────────────────────────────────────────

/** Stellar USDC (Centre Consortium) — Testnet & Mainnet */
export const USDC_TESTNET: AssetInfo = {
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  type: "credit_alphanum4",
  displayName: "USDC (Testnet)",
  decimals: 7,
  domain: "centre.io",
  orgName: "Centre Consortium",
};

export const USDC_MAINNET: AssetInfo = {
  code: "USDC",
  issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  type: "credit_alphanum4",
  displayName: "USDC",
  decimals: 7,
  domain: "centre.io",
  orgName: "Centre Consortium",
};

/** Native XLM */
export const XLM_ASSET: AssetInfo = {
  code: "XLM",
  type: "native",
  displayName: "Stellar Lumens",
  decimals: 7,
};

// ── Helpers ────────────────────────────────────────────────────

/** Get the known asset info for a given asset code (defaults to XLM). */
export function getAssetInfo(code: string): AssetInfo {
  const upper = code.toUpperCase();
  if (upper === "USDC") return USDC_TESTNET;
  if (upper === "XLM") return XLM_ASSET;
  return { code: upper, type: "credit_alphanum4", displayName: upper, decimals: 7 };
}

/** Format a stroop amount based on asset decimals. */
export function formatAssetAmount(stroops: number, asset: AssetInfo): string {
  const divisor = Math.pow(10, asset.decimals);
  return (stroops / divisor).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: asset.decimals,
  });
}

/** Validate an asset issuer address (must be a valid Stellar account). */
export function isValidAssetIssuer(address: string): boolean {
  return /^G[A-Z0-9]{55}$/.test(address);
}

/** Shorten an issuer address for display (e.g. GBNZ...W34U). */
export function truncateIssuer(address?: string, chars = 4): string {
  if (!address || typeof address !== "string") return "";
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

// ── SEP-1 Asset Metadata Discovery & Caching ───────────────────

export const METADATA_FETCH_TIMEOUT_MS = getMetadataTimeoutMs();
export const DEFAULT_METADATA_TIMEOUT_MS = METADATA_FETCH_TIMEOUT_MS;
export const MAX_TOML_SIZE_BYTES = 100 * 1024; // 100 KB
export const DOMAIN_CACHE_TTL_MS = 300_000; // 5 minutes
export const DEFAULT_DOMAIN_CACHE_TTL_MS = DOMAIN_CACHE_TTL_MS;

export interface Sep1Currency {
  code: string;
  issuer?: string;
  name?: string;
  desc?: string;
  org_name?: string;
  image?: string;
  display_decimals?: number;
  [key: string]: unknown;
}

export type CurrencyMetadata = Sep1Currency;

export interface Sep1TomlData {
  DOCUMENTATION?: {
    ORG_NAME?: string;
    ORG_URL?: string;
    ORG_LOGO?: string;
    ORG_DESCRIPTION?: string;
    [key: string]: unknown;
  };
  CURRENCIES?: Sep1Currency[];
  [key: string]: unknown;
}

export interface CachedDomainMetadata {
  domain: string;
  currencies: Sep1Currency[];
  orgName?: string;
  fetchedAt: number;
  get(code: string): Sep1Currency | undefined;
  has(code: string): boolean;
  readonly size: number;
}

export interface ResolvedAssetMetadata extends AssetInfo {
  displayDecimals?: number;
  resolved: boolean;
}

export interface ResolveAssetOptions {
  domain?: string;
  forceRefresh?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  horizonServer?: { loadAccount: (publicKey: string) => Promise<{ home_domain?: string | null }> };
}

export type FetchDomainTomlOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  forceRefresh?: boolean;
};

// In-memory caches: per domain and per issuer account
const domainCache = new Map<string, CachedDomainMetadata>();
const issuerDomainCache = new Map<string, { domain: string | null; fetchedAt: number }>();

/** Clear cached domain and issuer metadata. */
export function clearAssetMetadataCache(): void {
  domainCache.clear();
  issuerDomainCache.clear();
}

/** Manually set cached domain metadata (useful for tests or cache warming). */
export function setCachedDomainMetadata(
  domain: string,
  data: Partial<CachedDomainMetadata> & { currencies: Sep1Currency[] }
): void {
  const cleanDomain = domain.toLowerCase().trim();
  const currenciesMap = new Map<string, Sep1Currency>();
  for (const curr of data.currencies) {
    if (curr.code) {
      currenciesMap.set(curr.code.toUpperCase().trim(), curr);
    }
  }

  domainCache.set(cleanDomain, {
    domain: cleanDomain,
    currencies: data.currencies,
    orgName: data.orgName,
    fetchedAt: data.fetchedAt ?? Date.now(),
    get(code: string) {
      return currenciesMap.get(code.toUpperCase().trim());
    },
    has(code: string) {
      return currenciesMap.has(code.toUpperCase().trim());
    },
    get size() {
      return currenciesMap.size;
    },
  });
}

/** Get current count of cached domains. */
export function getDomainCacheSize(): number {
  return domainCache.size;
}

export function getDomainMetadataCacheSize(): number {
  return domainCache.size;
}

// ── TOML Parser & SSRF Guard ───────────────────────────────────

const BLOCKED_DOMAIN_SUFFIXES = [
  "localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".priv",
  ".test",
  ".example",
  ".invalid",
];

/**
 * Validate that a home domain is syntactically sound and passes SSRF checks.
 */
export function isSafeHomeDomain(domain: string): boolean {
  if (!domain || typeof domain !== "string") return false;
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!clean) return false;
  if (clean.includes(" ") || clean.includes("..")) return false;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(clean)) {
    return false;
  }
  if (
    clean === "localhost" ||
    BLOCKED_DOMAIN_SUFFIXES.some((suffix) => clean.endsWith(suffix))
  ) {
    return false;
  }
  return isSafeWebhookUrl(`https://${clean}/.well-known/stellar.toml`);
}

/**
 * Parse SEP-1 TOML content with support for [[CURRENCIES]] and [DOCUMENTATION].
 * Degrades gracefully on malformed lines without throwing.
 */
export function parseSep1Toml(content: string): Sep1TomlData {
  const result: Sep1TomlData = {
    CURRENCIES: [],
  };

  if (!content || typeof content !== "string") {
    return result;
  }

  let currentSection = "";
  let isCurrencyArray = false;
  let currentCurrency: Sep1Currency | null = null;

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Array of tables: [[CURRENCIES]]
    const arrayMatch = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/);
    if (arrayMatch) {
      const sectionName = arrayMatch[1];
      if (sectionName.toUpperCase() === "CURRENCIES") {
        isCurrencyArray = true;
        currentSection = "CURRENCIES";
        currentCurrency = { code: "" };
        result.CURRENCIES!.push(currentCurrency);
      } else {
        isCurrencyArray = false;
        currentSection = sectionName;
        currentCurrency = null;
      }
      continue;
    }

    // Section table: [SECTION]
    const tableMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (tableMatch) {
      const sectionName = tableMatch[1];
      isCurrencyArray = false;
      currentCurrency = null;
      currentSection = sectionName.toUpperCase();
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      continue;
    }

    // Key-value pair: key = value
    const kvMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let rawVal = kvMatch[2].trim();

      // Remove trailing inline comments
      let stripped = rawVal;
      if (rawVal.startsWith('"')) {
        const closeQuoteIdx = rawVal.indexOf('"', 1);
        if (closeQuoteIdx !== -1) {
          stripped = rawVal.slice(0, closeQuoteIdx + 1);
        }
      } else if (rawVal.startsWith("'")) {
        const closeQuoteIdx = rawVal.indexOf("'", 1);
        if (closeQuoteIdx !== -1) {
          stripped = rawVal.slice(0, closeQuoteIdx + 1);
        }
      } else {
        const hashIdx = rawVal.indexOf("#");
        if (hashIdx !== -1) {
          stripped = rawVal.slice(0, hashIdx).trim();
        }
      }
      rawVal = stripped;

      let parsedVal: string | number | boolean = rawVal;
      if (
        (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
        (rawVal.startsWith("'") && rawVal.endsWith("'"))
      ) {
        parsedVal = rawVal.slice(1, -1);
      } else if (rawVal === "true") {
        parsedVal = true;
      } else if (rawVal === "false") {
        parsedVal = false;
      } else if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
        parsedVal = Number(rawVal);
      }

      if (isCurrencyArray && currentCurrency) {
        (currentCurrency as Record<string, unknown>)[key] = parsedVal;
        if (key === "display_decimals" && typeof parsedVal === "number") {
          currentCurrency.display_decimals = parsedVal;
        }
      } else if (currentSection && result[currentSection] && typeof result[currentSection] === "object") {
        (result[currentSection] as Record<string, unknown>)[key] = parsedVal;
      } else {
        result[key] = parsedVal;
      }
    }
  }

  return result;
}

/**
 * Parse SEP-1 TOML and return a Map of currencies keyed by uppercase code.
 */
export function parseSep1TomlCurrencies(content: string): Map<string, Sep1Currency> {
  const map = new Map<string, Sep1Currency>();
  const parsed = parseSep1Toml(content);
  for (const curr of parsed.CURRENCIES || []) {
    if (curr.code) {
      map.set(curr.code.toUpperCase().trim(), curr);
    }
  }
  return map;
}

// ── Outbound Domain Fetcher ─────────────────────────────────────

/**
 * Fetch and parse SEP-1 TOML for an issuer domain.
 * Enforces timeout, size limits, SSRF guard, and caches results per domain.
 */
export async function fetchDomainToml(
  domain: string,
  optionsOrTimeout?: FetchDomainTomlOptions | number
): Promise<CachedDomainMetadata | null> {
  if (!domain) return null;
  const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!cleanDomain) return null;

  const options: FetchDomainTomlOptions =
    typeof optionsOrTimeout === "number"
      ? { timeoutMs: optionsOrTimeout }
      : optionsOrTimeout ?? {};

  const now = Date.now();

  if (!options.forceRefresh) {
    const cached = domainCache.get(cleanDomain);
    if (cached && now - cached.fetchedAt < DOMAIN_CACHE_TTL_MS) {
      return cached;
    }
  }

  // SSRF guard
  const tomlUrl = `https://${cleanDomain}/.well-known/stellar.toml`;
  if (!isSafeHomeDomain(cleanDomain) || !isSafeWebhookUrl(tomlUrl)) {
    return null;
  }

  const timeoutMs = options.timeoutMs ?? METADATA_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
    }
  }

  try {
    const fetchPromise = (async () => {
      const res = await fetch(tomlUrl, {
        method: "GET",
        headers: { Accept: "text/plain, text/toml, application/toml, */*" },
        signal: controller.signal,
      });

      if (!res.ok) {
        return null;
      }

      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_TOML_SIZE_BYTES) {
        return null;
      }

      const text = await res.text();
      if (text.length > MAX_TOML_SIZE_BYTES) {
        return null;
      }

      return text;
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        controller.abort();
        const err = new Error("TOML fetch timed out");
        err.name = "TimeoutError";
        reject(err);
      }, timeoutMs);
    });

    const text = await Promise.race([fetchPromise, timeoutPromise]);
    if (!text) {
      return null;
    }

    const parsed = parseSep1Toml(text);
    const orgName = parsed.DOCUMENTATION?.ORG_NAME as string | undefined;
    const currencies = parsed.CURRENCIES || [];

    const currenciesMap = new Map<string, Sep1Currency>();
    for (const curr of currencies) {
      if (curr.code) {
        currenciesMap.set(curr.code.toUpperCase().trim(), curr);
      }
    }

    const entry: CachedDomainMetadata = {
      domain: cleanDomain,
      currencies,
      orgName,
      fetchedAt: now,
      get(code: string) {
        return currenciesMap.get(code.toUpperCase().trim());
      },
      has(code: string) {
        return currenciesMap.has(code.toUpperCase().trim());
      },
      get size() {
        return currenciesMap.size;
      },
    };

    domainCache.set(cleanDomain, entry);
    return entry;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lookup the home_domain for a Stellar issuing account from Horizon.
 */
export async function fetchIssuerHomeDomain(
  issuer: string,
  options?: ResolveAssetOptions
): Promise<string | null> {
  const now = Date.now();
  if (!options?.forceRefresh) {
    const cached = issuerDomainCache.get(issuer);
    if (cached && now - cached.fetchedAt < DOMAIN_CACHE_TTL_MS) {
      return cached.domain;
    }
  }

  if (!isValidAssetIssuer(issuer)) {
    return null;
  }

  const timeoutMs = options?.timeoutMs ?? METADATA_FETCH_TIMEOUT_MS;

  // If custom horizonServer is provided in options (e.g. in unit tests):
  if (options?.horizonServer) {
    try {
      const accountPromise = options.horizonServer.loadAccount(issuer);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Horizon loadAccount timed out")), timeoutMs);
      });
      const account = await Promise.race([accountPromise, timeoutPromise]);
      const domain = (account?.home_domain as string)?.toLowerCase().trim() || null;
      issuerDomainCache.set(issuer, { domain, fetchedAt: now });
      return domain;
    } catch {
      issuerDomainCache.set(issuer, { domain: null, fetchedAt: now });
      return null;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
    }
  }

  try {
    const url = `${HORIZON_URL}/accounts/${issuer}`;
    const fetchPromise = (async () => {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const data = await res.json();
      return (data?.home_domain as string)?.toLowerCase().trim() || null;
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        controller.abort();
        reject(new Error("Horizon request timed out"));
      }, timeoutMs);
    });

    const domain = await Promise.race([fetchPromise, timeoutPromise]);
    issuerDomainCache.set(issuer, { domain, fetchedAt: now });
    return domain;
  } catch {
    issuerDomainCache.set(issuer, { domain: null, fetchedAt: now });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Asset Metadata Resolution ───────────────────────────────────

/**
 * Resolve asset metadata from the issuer's SEP-1 TOML.
 *
 * • Checks built-in known assets first (XLM, USDC).
 * • Resolves issuer's home domain via Horizon (or provided domain option).
 * • Fetches and parses SEP-1 TOML adhering to size/timeout limits.
 * • Caches results per issuer domain with TTL.
 * • Gracefully degrades to raw code + issuer when metadata is missing or unreachable.
 */
export async function resolveAssetMetadata(
  code: string,
  issuer?: string,
  options?: ResolveAssetOptions
): Promise<ResolvedAssetMetadata> {
  const upperCode = (code || "XLM").toUpperCase().trim();
  const assetType =
    upperCode === "XLM" && !issuer
      ? "native"
      : upperCode.length <= 4
      ? "credit_alphanum4"
      : "credit_alphanum12";

  // Native XLM
  if (upperCode === "XLM" && !issuer) {
    return {
      code: "XLM",
      type: "native",
      displayName: "Stellar Lumens",
      name: "Stellar Lumens",
      decimals: 7,
      resolved: true,
    };
  }

  // Known USDC shortcuts
  if (issuer === USDC_TESTNET.issuer) {
    return {
      code: "USDC",
      issuer: USDC_TESTNET.issuer,
      type: "credit_alphanum4",
      displayName: "USDC (Testnet)",
      name: "USD Coin",
      orgName: "Centre Consortium",
      domain: "centre.io",
      decimals: 7,
      displayDecimals: 7,
      resolved: true,
    };
  }
  if (issuer === USDC_MAINNET.issuer) {
    return {
      code: "USDC",
      issuer: USDC_MAINNET.issuer,
      type: "credit_alphanum4",
      displayName: "USDC",
      name: "USD Coin",
      orgName: "Centre Consortium",
      domain: "centre.io",
      decimals: 7,
      displayDecimals: 7,
      resolved: true,
    };
  }

  // Base degraded representation
  const fallbackResult: ResolvedAssetMetadata = {
    code: upperCode,
    issuer,
    type: assetType,
    displayName: upperCode,
    decimals: 7,
    resolved: false,
  };

  if (!issuer && !options?.domain) {
    return fallbackResult;
  }

  try {
    let domain = options?.domain?.toLowerCase().trim();
    if (!domain && issuer) {
      domain = (await fetchIssuerHomeDomain(issuer, options)) || undefined;
    }

    if (!domain) {
      return fallbackResult;
    }

    fallbackResult.domain = domain;

    const domainMeta = await fetchDomainToml(domain, options);
    if (!domainMeta) {
      return fallbackResult;
    }

    const currency = domainMeta.currencies.find((c) => {
      const matchCode = c.code?.toUpperCase() === upperCode;
      if (!matchCode) return false;
      if (issuer && c.issuer) {
        return c.issuer === issuer;
      }
      return true;
    });

    if (currency) {
      const displayName = currency.name || upperCode;
      return {
        code: upperCode,
        issuer: currency.issuer || issuer,
        type: assetType,
        displayName,
        name: currency.name,
        desc: currency.desc,
        description: currency.desc,
        orgName: currency.org_name || domainMeta.orgName,
        domain,
        decimals: currency.display_decimals ?? 7,
        displayDecimals: currency.display_decimals,
        resolved: true,
      };
    }

    return fallbackResult;
  } catch {
    return fallbackResult;
  }
}

/** Format an asset for human-readable display with optional issuer. */
export function formatAssetDisplay(code: string, issuer?: string, name?: string): string {
  const upper = (code || "XLM").toUpperCase().trim();
  if (upper === "XLM" || !issuer) return upper;
  const label = name ? `${name} (${upper})` : upper;
  return `${label} · ${truncateIssuer(issuer)}`;
}
