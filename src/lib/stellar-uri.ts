// SPDX-License-Identifier: MIT

import { isValidStellarAddress } from "@/lib/stellar";

/**
 * SEP-7 (Stellar URI Scheme) payload builders, parsers, and validators.
 *
 * SEP-7 defines URIs like `web+stellar:pay?destination=G...` that Stellar
 * wallets recognize and act on. On mobile devices, browsers cannot invoke
 * browser-extension wallets, so SEP-7 URIs provide the standardized handoff
 * to mobile wallet apps (Lobstr, Solar, Beans, Decaf, Vibrant).
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */

export interface Sep7PayParams {
  /** Required — the destination Stellar account (G...) or federated address. */
  destination: string;
  /** Optional — amount in the asset's base units. */
  amount?: string;
  /** Optional — transaction memo. */
  memo?: string;
  /** Optional — memo type; defaults to MEMO_TEXT when a memo is provided. */
  memoType?: "MEMO_TEXT" | "MEMO_ID" | "MEMO_HASH" | "MEMO_RETURN";
  /** Optional — asset code; omitted (native XLM) when "XLM". */
  assetCode?: string;
  /** Optional — asset issuer for non-native assets. */
  assetIssuer?: string;
  /** Optional — human-readable message shown to the sender. */
  msg?: string;
  /** Optional — Stellar network passphrase override. */
  networkPassphrase?: string;
  /** Optional — callback URL (prefix `url:...`). */
  callback?: string;
}

export interface Sep7ValidationResult {
  valid: boolean;
  error?: string;
  params?: Sep7PayParams;
}

export interface SupportedMobileWallet {
  name: string;
  platforms: string[];
  url: string;
  description: string;
}

export const SUPPORTED_MOBILE_WALLETS: SupportedMobileWallet[] = [
  {
    name: "Lobstr",
    platforms: ["iOS", "Android"],
    url: "https://lobstr.co",
    description: "Leading mobile wallet for Stellar Lumens and tokens with full SEP-7 support.",
  },
  {
    name: "Solar Wallet",
    platforms: ["iOS", "Android", "Desktop"],
    url: "https://solarwallet.io",
    description: "Decentralized Stellar wallet with native SEP-7 and multi-signature support.",
  },
  {
    name: "Beans App",
    platforms: ["iOS", "Android"],
    url: "https://www.beansapp.com",
    description: "Mobile wallet for zero-fee payments with SEP-7 protocol handoff.",
  },
  {
    name: "Decaf",
    platforms: ["iOS", "Android"],
    url: "https://www.decaf.so",
    description: "Global Stellar consumer wallet supporting web+stellar:pay links.",
  },
  {
    name: "Vibrant",
    platforms: ["iOS", "Android"],
    url: "https://vibrantapp.com",
    description: "Stellar dollar wallet (USDC) with support for mobile payments.",
  },
];

/**
 * Build a SEP-7 `web+stellar:pay` URI.
 *
 * Only the destination is required. Optional params are omitted when empty
 * so the payload stays compact, and the native XLM asset is never encoded
 * as `asset_code` (per SEP-7, native payments omit the asset entirely).
 */
export function buildSep7PayUri(params: Sep7PayParams): string {
  const url = new URL("web+stellar:pay");
  url.searchParams.set("destination", params.destination);

  if (params.amount !== undefined && params.amount !== "") {
    url.searchParams.set("amount", params.amount);
  }
  if (params.memo) {
    url.searchParams.set("memo", params.memo);
    if (params.memoType) {
      url.searchParams.set("memo_type", params.memoType);
    }
  }
  if (params.assetCode && params.assetCode !== "XLM") {
    url.searchParams.set("asset_code", params.assetCode);
    if (params.assetIssuer) {
      url.searchParams.set("asset_issuer", params.assetIssuer);
    }
  }
  if (params.msg) {
    url.searchParams.set("msg", params.msg);
  }
  if (params.networkPassphrase) {
    url.searchParams.set("network_passphrase", params.networkPassphrase);
  }
  if (params.callback) {
    url.searchParams.set("callback", params.callback);
  }

  return url.toString();
}

/**
 * Build the receive payload for an account: a SEP-7 `pay` URI with no
 * amount, so the sender picks how much to send.
 */
export function buildReceivePayload(
  address: string,
  options?: Partial<Sep7PayParams>
): string {
  return buildSep7PayUri({ destination: address, ...options });
}

/**
 * Validate a URI string against the SEP-7 `web+stellar:pay` grammar.
 *
 * Checks:
 * - Scheme and operation are `web+stellar:pay?`
 * - Destination is a valid Stellar address or federation address
 * - Amount is a positive decimal string with up to 7 decimal places (stroop precision)
 * - Asset code is 1-12 alphanumeric characters if present
 * - Non-native asset requires valid asset_issuer
 * - Native XLM asset forbids asset_issuer
 * - Memo length and format adhere to memo_type constraints (28 bytes for TEXT, 64-bit uint for ID, 32-byte hex/b64 for HASH/RETURN)
 * - Message is at most 300 characters
 * - Callback URL begins with `url:`
 */
export function validateSep7Uri(uri: string): Sep7ValidationResult {
  if (typeof uri !== "string" || !uri.trim()) {
    return { valid: false, error: "URI cannot be empty" };
  }

  if (!uri.startsWith("web+stellar:pay?")) {
    return { valid: false, error: "URI must begin with 'web+stellar:pay?'" };
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { valid: false, error: "Invalid URI syntax" };
  }

  if (parsed.protocol !== "web+stellar:" || parsed.pathname !== "pay") {
    return { valid: false, error: "URI must use web+stellar:pay scheme and operation" };
  }

  const destination = parsed.searchParams.get("destination");
  if (!destination) {
    return { valid: false, error: "Missing required 'destination' parameter" };
  }

  const isAddress = isValidStellarAddress(destination);
  const isFederated = /^[a-zA-Z0-9._%+-]+(\*[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/.test(destination);
  if (!isAddress && !isFederated) {
    return { valid: false, error: "Invalid Stellar destination address or federated account" };
  }

  const amount = parsed.searchParams.get("amount") ?? undefined;
  if (amount !== undefined) {
    if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) {
      return { valid: false, error: "Amount must be a positive decimal number with up to 7 decimal places" };
    }
  }

  const assetCode = parsed.searchParams.get("asset_code") ?? undefined;
  const assetIssuer = parsed.searchParams.get("asset_issuer") ?? undefined;

  if (assetCode) {
    if (!/^[a-zA-Z0-9]{1,12}$/.test(assetCode)) {
      return { valid: false, error: "asset_code must be 1 to 12 alphanumeric characters" };
    }
    if (assetCode.toUpperCase() !== "XLM" && !assetIssuer) {
      return { valid: false, error: "asset_issuer is required for non-native assets" };
    }
    if (assetCode.toUpperCase() === "XLM" && assetIssuer) {
      return { valid: false, error: "asset_issuer cannot be provided for native XLM asset" };
    }
  } else if (assetIssuer) {
    return { valid: false, error: "asset_issuer cannot be provided without asset_code" };
  }

  if (assetIssuer && !isValidStellarAddress(assetIssuer)) {
    return { valid: false, error: "asset_issuer must be a valid Stellar public key" };
  }

  const memo = parsed.searchParams.get("memo") ?? undefined;
  const rawMemoType = parsed.searchParams.get("memo_type") ?? undefined;
  let memoType: Sep7PayParams["memoType"] = undefined;

  if (rawMemoType) {
    if (!["MEMO_TEXT", "MEMO_ID", "MEMO_HASH", "MEMO_RETURN"].includes(rawMemoType)) {
      return { valid: false, error: "memo_type must be MEMO_TEXT, MEMO_ID, MEMO_HASH, or MEMO_RETURN" };
    }
    if (memo === undefined) {
      return { valid: false, error: "memo_type cannot be specified without a memo" };
    }
    memoType = rawMemoType as Sep7PayParams["memoType"];
  }

  if (memo !== undefined) {
    const effectiveMemoType = memoType ?? "MEMO_TEXT";
    if (effectiveMemoType === "MEMO_TEXT") {
      const bytes = new TextEncoder().encode(memo);
      if (bytes.length > 28) {
        return { valid: false, error: "MEMO_TEXT exceeds 28 byte limit" };
      }
    } else if (effectiveMemoType === "MEMO_ID") {
      if (!/^\d+$/.test(memo)) {
        return { valid: false, error: "MEMO_ID must be a 64-bit unsigned integer" };
      }
      try {
        const val = BigInt(memo);
        if (val < BigInt(0) || val > BigInt("18446744073709551615")) {
          return { valid: false, error: "MEMO_ID out of 64-bit range" };
        }
      } catch {
        return { valid: false, error: "MEMO_ID invalid integer" };
      }
    } else if (effectiveMemoType === "MEMO_HASH" || effectiveMemoType === "MEMO_RETURN") {
      const isHex = /^[0-9a-fA-F]{64}$/.test(memo);
      const isBase64 = /^[A-Za-z0-9+/]{43}=*$/.test(memo);
      if (!isHex && !isBase64) {
        return { valid: false, error: `${effectiveMemoType} must be 32-byte hex or base64` };
      }
    }
  }

  const msg = parsed.searchParams.get("msg") ?? undefined;
  if (msg && msg.length > 300) {
    return { valid: false, error: "msg exceeds 300 characters" };
  }

  const networkPassphrase = parsed.searchParams.get("network_passphrase") ?? undefined;
  const callback = parsed.searchParams.get("callback") ?? undefined;
  if (callback && !callback.startsWith("url:")) {
    return { valid: false, error: "callback must begin with 'url:'" };
  }

  return {
    valid: true,
    params: {
      destination,
      amount,
      assetCode,
      assetIssuer,
      memo,
      memoType,
      msg,
      networkPassphrase,
      callback,
    },
  };
}

/** Check if a URI string is a valid SEP-7 pay URI. */
export function isValidSep7Uri(uri: string): boolean {
  return validateSep7Uri(uri).valid;
}

/**
 * Parse a SEP-7 `web+stellar:pay` URI into typed params.
 * Returns null if the URI does not strictly conform to SEP-7 grammar.
 */
export function parseSep7PayUri(uri: string): Sep7PayParams | null {
  const result = validateSep7Uri(uri);
  return result.valid && result.params ? result.params : null;
}
