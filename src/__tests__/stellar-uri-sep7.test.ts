// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  buildSep7PayUri,
  parseSep7PayUri,
  validateSep7Uri,
  isValidSep7Uri,
  buildReceivePayload,
  SUPPORTED_MOBILE_WALLETS,
} from "@/lib/stellar-uri";
import {
  generateSep7PaymentUri,
  parsePaymentLink,
  generatePaymentQrData,
  generatePaymentLink,
  type PaymentLinkParams,
} from "@/lib/payment-link";

const VALID_ADDR_1 = "GBQMIN7KLT4R473IGGFBGUYM2UNPGKZRTX2LZ4M2KQIY2ASYJL6ACBMZ";
const VALID_ADDR_2 = "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEF";
const ISSUER_ADDR = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const INVALID_ADDR = "not-a-valid-stellar-address";

describe("SEP-7 URI Grammar Validation (validateSep7Uri & isValidSep7Uri)", () => {
  it("validates a minimal valid SEP-7 pay URI with only destination", () => {
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}`;
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(true);
    expect(result.params?.destination).toBe(VALID_ADDR_1);
    expect(isValidSep7Uri(uri)).toBe(true);
  });

  it("validates a comprehensive SEP-7 pay URI carrying all fields", () => {
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}&amount=100.5&memo=invoice-123&memo_type=MEMO_TEXT&asset_code=USDC&asset_issuer=${ISSUER_ADDR}&msg=Thank+you`;
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(true);
    expect(result.params).toEqual({
      destination: VALID_ADDR_1,
      amount: "100.5",
      memo: "invoice-123",
      memoType: "MEMO_TEXT",
      assetCode: "USDC",
      assetIssuer: ISSUER_ADDR,
      msg: "Thank you",
      networkPassphrase: undefined,
      callback: undefined,
    });
    expect(isValidSep7Uri(uri)).toBe(true);
  });

  it("accepts a federated destination address", () => {
    const uri = "web+stellar:pay?destination=alice*stellar.org";
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(true);
    expect(result.params?.destination).toBe("alice*stellar.org");
    expect(isValidSep7Uri(uri)).toBe(true);
  });

  it("rejects empty or whitespace-only URIs", () => {
    expect(validateSep7Uri("").valid).toBe(false);
    expect(validateSep7Uri("   ").valid).toBe(false);
    expect(isValidSep7Uri("")).toBe(false);
  });

  it("rejects URIs without web+stellar:pay? prefix or incorrect scheme", () => {
    expect(validateSep7Uri(`https://example.com/pay?destination=${VALID_ADDR_1}`).valid).toBe(false);
    expect(validateSep7Uri(`stellar:pay?destination=${VALID_ADDR_1}`).valid).toBe(false);
    expect(validateSep7Uri(`web+stellar:tx?destination=${VALID_ADDR_1}`).valid).toBe(false);
    expect(validateSep7Uri("not-a-uri").valid).toBe(false);
  });

  it("rejects URIs missing the destination parameter", () => {
    const result = validateSep7Uri("web+stellar:pay?amount=10");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("destination");
  });

  it("rejects invalid destination public keys", () => {
    const result = validateSep7Uri(`web+stellar:pay?destination=${INVALID_ADDR}`);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid Stellar destination");
  });

  it("rejects invalid, negative, or zero amounts", () => {
    expect(validateSep7Uri(`web+stellar:pay?destination=${VALID_ADDR_1}&amount=-5`).valid).toBe(false);
    expect(validateSep7Uri(`web+stellar:pay?destination=${VALID_ADDR_1}&amount=0`).valid).toBe(false);
    expect(validateSep7Uri(`web+stellar:pay?destination=${VALID_ADDR_1}&amount=abc`).valid).toBe(false);
    expect(validateSep7Uri(`web+stellar:pay?destination=${VALID_ADDR_1}&amount=10.12345678`).valid).toBe(false);
  });

  it("accepts amounts with up to 7 decimal places (stroop precision)", () => {
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}&amount=12.3456789`;
    expect(validateSep7Uri(uri).valid).toBe(true);
  });

  it("rejects non-native assets without asset_issuer", () => {
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}&asset_code=USDC`;
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("asset_issuer is required");
  });

  it("rejects native XLM asset with asset_issuer provided", () => {
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}&asset_code=XLM&asset_issuer=${ISSUER_ADDR}`;
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("asset_issuer cannot be provided for native XLM");
  });

  it("rejects asset_issuer without asset_code", () => {
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}&asset_issuer=${ISSUER_ADDR}`;
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("asset_issuer cannot be provided without asset_code");
  });

  it("rejects invalid asset_issuer address", () => {
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}&asset_code=USDC&asset_issuer=${INVALID_ADDR}`;
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("asset_issuer must be a valid Stellar public key");
  });

  it("rejects asset_code longer than 12 characters", () => {
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}&asset_code=TOOLONGASSETCODE&asset_issuer=${ISSUER_ADDR}`;
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("1 to 12 alphanumeric characters");
  });

  it("rejects orphaned memo_type without memo", () => {
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}&memo_type=MEMO_TEXT`;
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("memo_type cannot be specified without a memo");
  });

  it("rejects invalid memo_type values", () => {
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}&memo=test&memo_type=INVALID_TYPE`;
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("memo_type must be");
  });

  it("rejects MEMO_TEXT exceeding 28 bytes", () => {
    const longMemo = "a".repeat(29);
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}&memo=${longMemo}&memo_type=MEMO_TEXT`;
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("28 byte limit");
  });

  it("validates MEMO_ID format and range", () => {
    const validIdUri = `web+stellar:pay?destination=${VALID_ADDR_1}&memo=123456789&memo_type=MEMO_ID`;
    expect(validateSep7Uri(validIdUri).valid).toBe(true);

    const nonNumberUri = `web+stellar:pay?destination=${VALID_ADDR_1}&memo=abc&memo_type=MEMO_ID`;
    expect(validateSep7Uri(nonNumberUri).valid).toBe(false);

    const outOfRangeUri = `web+stellar:pay?destination=${VALID_ADDR_1}&memo=18446744073709551616&memo_type=MEMO_ID`;
    expect(validateSep7Uri(outOfRangeUri).valid).toBe(false);
  });

  it("validates MEMO_HASH format", () => {
    const validHexHash = "a".repeat(64);
    const validHashUri = `web+stellar:pay?destination=${VALID_ADDR_1}&memo=${validHexHash}&memo_type=MEMO_HASH`;
    expect(validateSep7Uri(validHashUri).valid).toBe(true);

    const invalidHashUri = `web+stellar:pay?destination=${VALID_ADDR_1}&memo=short&memo_type=MEMO_HASH`;
    expect(validateSep7Uri(invalidHashUri).valid).toBe(false);
  });

  it("rejects messages exceeding 300 characters", () => {
    const longMsg = "x".repeat(301);
    const uri = `web+stellar:pay?destination=${VALID_ADDR_1}&msg=${longMsg}`;
    const result = validateSep7Uri(uri);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("300 characters");
  });

  it("validates callback URL prefix", () => {
    const validCallback = `web+stellar:pay?destination=${VALID_ADDR_1}&callback=url:https%3A%2F%2Fexample.com%2Fcallback`;
    expect(validateSep7Uri(validCallback).valid).toBe(true);

    const invalidCallback = `web+stellar:pay?destination=${VALID_ADDR_1}&callback=https%3A%2F%2Fexample.com%2Fcallback`;
    expect(validateSep7Uri(invalidCallback).valid).toBe(false);
  });
});

describe("SEP-7 URI Builder & Parser Round-Trip (buildSep7PayUri & parseSep7PayUri)", () => {
  it("maintains round-trip fidelity asserting every field", () => {
    const input = {
      destination: VALID_ADDR_1,
      amount: "25.75",
      memo: "invoice-42",
      memoType: "MEMO_TEXT" as const,
      assetCode: "USDC",
      assetIssuer: ISSUER_ADDR,
      msg: "Payment for consulting services",
    };

    const uri = buildSep7PayUri(input);
    expect(uri.startsWith("web+stellar:pay?")).toBe(true);
    expect(isValidSep7Uri(uri)).toBe(true);

    const parsed = parseSep7PayUri(uri);
    expect(parsed).toEqual(input);
  });

  it("omits native XLM asset from URI query params per SEP-7 specification", () => {
    const uri = buildSep7PayUri({
      destination: VALID_ADDR_1,
      assetCode: "XLM",
    });
    expect(uri).not.toContain("asset_code");
    expect(uri).not.toContain("asset_issuer");
    expect(uri).toBe(`web+stellar:pay?destination=${VALID_ADDR_1}`);
    expect(isValidSep7Uri(uri)).toBe(true);
  });

  it("omits optional params when not specified", () => {
    const uri = buildSep7PayUri({ destination: VALID_ADDR_2 });
    expect(uri).toBe(`web+stellar:pay?destination=${VALID_ADDR_2}`);
    const parsed = parseSep7PayUri(uri);
    expect(parsed).toEqual({ destination: VALID_ADDR_2 });
  });

  it("preserves URL-encoded special characters in memo and message", () => {
    const input = {
      destination: VALID_ADDR_1,
      memo: "item & details",
      msg: "Thank you & have a great day!",
    };
    const uri = buildSep7PayUri(input);
    const parsed = parseSep7PayUri(uri);
    expect(parsed?.memo).toBe("item & details");
    expect(parsed?.msg).toBe("Thank you & have a great day!");
  });
});

describe("buildReceivePayload", () => {
  it("builds a receive payload with destination only", () => {
    const uri = buildReceivePayload(VALID_ADDR_1);
    expect(uri).toBe(`web+stellar:pay?destination=${VALID_ADDR_1}`);
    expect(isValidSep7Uri(uri)).toBe(true);
  });

  it("builds a receive payload with prefilled amount and memo", () => {
    const uri = buildReceivePayload(VALID_ADDR_1, {
      amount: "50",
      memo: "Lunch",
    });
    expect(uri).toContain("amount=50");
    expect(uri).toContain("memo=Lunch");
    expect(isValidSep7Uri(uri)).toBe(true);
  });
});

describe("Payment Link Round-Trip with SEP-7 (parsePaymentLink & generateSep7PaymentUri)", () => {
  it("round-trips through existing payment link parsing asserting EVERY field", () => {
    const paymentParams: PaymentLinkParams = {
      destination: VALID_ADDR_1,
      amount: "100.50",
      memo: "order-9988",
      memoType: "MEMO_TEXT",
      assetCode: "USDC",
      assetIssuer: ISSUER_ADDR,
      message: "Monthly subscription fee",
    };

    // 1. Generate SEP-7 URI
    const sep7Uri = generateSep7PaymentUri(paymentParams);
    expect(isValidSep7Uri(sep7Uri)).toBe(true);

    // 2. Parse through parsePaymentLink
    const parsed = parsePaymentLink(sep7Uri);

    // 3. Assert EVERY field round-trips
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({
      destination: paymentParams.destination,
      amount: paymentParams.amount,
      memo: paymentParams.memo,
      memoType: paymentParams.memoType,
      assetCode: paymentParams.assetCode,
      assetIssuer: paymentParams.assetIssuer,
      message: paymentParams.message,
    });
  });

  it("generates SEP-7 QR data via generatePaymentQrData and parses it back", () => {
    const params: PaymentLinkParams = {
      destination: VALID_ADDR_2,
      amount: "15",
      memo: "coffee",
    };
    const qrData = generatePaymentQrData(params);
    expect(qrData.startsWith("web+stellar:pay?")).toBe(true);
    expect(isValidSep7Uri(qrData)).toBe(true);

    const parsed = parsePaymentLink(qrData);
    expect(parsed).toEqual(params);
  });

  it("continues to parse standard web payment links (/pay/[address])", () => {
    const webLink = generatePaymentLink({
      destination: VALID_ADDR_1,
      amount: "45",
      memo: "donation",
      assetCode: "USDC",
      assetIssuer: ISSUER_ADDR,
      message: "Support open source",
    });
    const parsed = parsePaymentLink(webLink);
    expect(parsed).toEqual({
      destination: VALID_ADDR_1,
      amount: "45",
      memo: "donation",
      assetCode: "USDC",
      assetIssuer: ISSUER_ADDR,
      message: "Support open source",
    });
  });
});

describe("Supported Mobile Wallets Catalog", () => {
  it("includes all top Stellar mobile wallets with required metadata", () => {
    const names = SUPPORTED_MOBILE_WALLETS.map((w) => w.name);
    expect(names).toContain("Lobstr");
    expect(names).toContain("Solar Wallet");
    expect(names).toContain("Beans App");
    expect(names).toContain("Decaf");
    expect(names).toContain("Vibrant");

    SUPPORTED_MOBILE_WALLETS.forEach((wallet) => {
      expect(wallet.name).toBeTruthy();
      expect(wallet.platforms.length).toBeGreaterThan(0);
      expect(wallet.url.startsWith("https://")).toBe(true);
      expect(wallet.description).toBeTruthy();
    });
  });
});
