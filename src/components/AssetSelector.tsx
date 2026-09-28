"use client";
// SPDX-License-Identifier: MIT

import { useState, useEffect, useCallback } from "react";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { cn } from "@/lib/utils";
import {
  XLM_ASSET,
  USDC_TESTNET,
  USDC_MAINNET,
  type AssetInfo,
  resolveAssetMetadata,
  truncateIssuer,
  isValidAssetIssuer,
} from "@/lib/assets";
import { fetchAllBalances, getHorizonServer, NETWORK_PASSPHRASE, STELLAR_NETWORK, type AssetBalance } from "@/lib/stellar";
import { buildTrustlineTransaction, checkTrustline, getTrustlineMessage, type TrustlineState } from "@/lib/trustline";
import { getActiveWalletConnector } from "@/lib/wallets";

// ── Helpers ────────────────────────────────────────────────────

const KNOWN_ASSETS: AssetInfo[] = [
  XLM_ASSET,
  STELLAR_NETWORK === "PUBLIC" ? USDC_MAINNET : USDC_TESTNET,
];

function findAssetBalance(
  balances: AssetBalance[],
  asset: AssetInfo,
): string {
  if (asset.type === "native") {
    return balances.find((b) => b.type === "native")?.balance ?? "0";
  }
  return (
    balances.find(
      (b) => b.assetCode === asset.code && b.assetIssuer === asset.issuer,
    )?.balance ?? "0"
  );
}

interface AssetSelectorProps {
  publicKey: string | null;
  selectedAsset: AssetInfo;
  onSelect: (asset: AssetInfo) => void;
  className?: string;
  disabled?: boolean;
}

// ── Component ──────────────────────────────────────────────────

export function AssetSelector({
  publicKey,
  selectedAsset,
  onSelect,
  className,
  disabled = false,
}: AssetSelectorProps) {
  const [balances, setBalances] = useState<AssetBalance[]>([]);
  const [customAssets, setCustomAssets] = useState<AssetInfo[]>([]);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customCode, setCustomCode] = useState("");
  const [customIssuer, setCustomIssuer] = useState("");
  const [resolvingCustom, setResolvingCustom] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [showFullIssuer, setShowFullIssuer] = useState(false);
  const [trustlineStatus, setTrustlineStatus] = useState<
    Record<string, { hasTrustline: boolean; checking: boolean; state?: TrustlineState }>
  >({});
  const [settingUpTrustline, setSettingUpTrustline] = useState(false);
  const [trustlineError, setTrustlineError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const fetchBalances = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    try {
      const allBalances = await fetchAllBalances(publicKey);
      setBalances(allBalances);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  useEffect(() => {
    if (!publicKey || selectedAsset.type === "native" || !selectedAsset.issuer) return;
    const key = `${selectedAsset.code}:${selectedAsset.issuer}`;
    let cancelled = false;
    setTrustlineStatus((prev) => ({
      ...prev,
      [key]: { ...prev[key], checking: true },
    }));
    checkTrustline(publicKey, selectedAsset.code, selectedAsset.issuer).then((info) => {
      if (cancelled) return;
      setTrustlineStatus((prev) => ({
        ...prev,
        [key]: { hasTrustline: info.hasTrustline, checking: false, state: info.state },
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [publicKey, selectedAsset.code, selectedAsset.issuer, selectedAsset.type]);

  const handleSelect = async (asset: AssetInfo) => {
    // For non-native assets, check trustline before selecting
    if (asset.type !== "native" && asset.issuer && publicKey) {
      const key = `${asset.code}:${asset.issuer}`;
      setTrustlineStatus((prev) => ({
        ...prev,
        [key]: { ...prev[key], checking: true },
      }));

      const info = await checkTrustline(publicKey, asset.code, asset.issuer);

      setTrustlineStatus((prev) => ({
        ...prev,
        [key]: { hasTrustline: info.hasTrustline, checking: false, state: info.state },
      }));
      if (info.state !== "authorized") {
        onSelect(asset);
        return;
      }
    }

    onSelect(asset);
    setOpen(false);
  };

  const handleSetupTrustline = async (asset: AssetInfo) => {
    if (!publicKey || !asset.issuer) return;
    setSettingUpTrustline(true);
    setTrustlineError(null);
    try {
      const connector = getActiveWalletConnector();
      if (!connector) throw new Error("Reconnect your wallet to create this trustline.");
      const { xdr } = await buildTrustlineTransaction(publicKey, asset.code, asset.issuer);
      const signedXdr = await connector.signTransaction(xdr, {
        network: STELLAR_NETWORK,
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      const transaction = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
      await getHorizonServer().submitTransaction(transaction);
      const verifiedTrustline = await checkTrustline(publicKey, asset.code, asset.issuer);
      const key = `${asset.code}:${asset.issuer}`;
      setTrustlineStatus((prev) => ({
        ...prev,
        [key]: {
          hasTrustline: verifiedTrustline.hasTrustline,
          checking: false,
          state: verifiedTrustline.state,
        },
      }));
      onSelect(asset);
      await fetchBalances();
      setOpen(false);
    } catch (error) {
      setTrustlineError(error instanceof Error ? error.message : "Trustline setup failed.");
    } finally {
      setSettingUpTrustline(false);
    }
  };

  const handleAddCustomAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = customCode.trim().toUpperCase();
    const issuer = customIssuer.trim();
    if (!code) return;

    if (issuer && !isValidAssetIssuer(issuer)) {
      setResolveError("Invalid Stellar issuer public key (must start with G, 56 characters)");
      return;
    }

    setResolvingCustom(true);
    setResolveError(null);
    try {
      const meta = await resolveAssetMetadata(code, issuer || undefined);
      const newAsset: AssetInfo = {
        code: meta.code,
        issuer: meta.issuer,
        type: meta.type,
        displayName: meta.displayName,
        decimals: meta.displayDecimals ?? 7,
        domain: meta.domain,
        orgName: meta.orgName,
        desc: meta.desc,
      };
      setCustomAssets((prev) => {
        const exists = prev.some(
          (a) => a.code === newAsset.code && a.issuer === newAsset.issuer
        );
        return exists ? prev : [...prev, newAsset];
      });
      await handleSelect(newAsset);
      setShowCustomInput(false);
      setCustomCode("");
      setCustomIssuer("");
    } catch {
      const fallback: AssetInfo = {
        code,
        issuer: issuer || undefined,
        type: code === "XLM" && !issuer ? "native" : code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
        displayName: code,
        decimals: 7,
      };
      setCustomAssets((prev) => [...prev, fallback]);
      await handleSelect(fallback);
      setShowCustomInput(false);
      setCustomCode("");
      setCustomIssuer("");
    } finally {
      setResolvingCustom(false);
    }
  };

  const allAssets = [...KNOWN_ASSETS, ...customAssets];
  const balance = findAssetBalance(balances, selectedAsset);

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={cn(
          "w-full flex items-center justify-between gap-2 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm transition-colors",
          !disabled &&
            "hover:border-gray-300 dark:hover:border-gray-600 cursor-pointer",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        <span className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-ophir-100 dark:bg-ophir-900/30 flex items-center justify-center text-xs font-bold text-ophir-700 dark:text-ophir-300">
            {selectedAsset.code.slice(0, 2)}
          </span>
          <span className="text-left flex flex-col">
            <span className="text-gray-900 dark:text-white font-medium flex items-center gap-1.5">
              <span>{selectedAsset.code}</span>
              {selectedAsset.displayName &&
                selectedAsset.displayName !== selectedAsset.code && (
                  <span className="text-xs text-gray-500 dark:text-gray-400 font-normal">
                    ({selectedAsset.displayName})
                  </span>
                )}
            </span>
            {selectedAsset.issuer && (
              <span
                className="text-[10px] text-gray-400 font-mono hover:underline cursor-pointer"
                title={selectedAsset.issuer}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowFullIssuer((prev) => !prev);
                }}
              >
                {showFullIssuer
                  ? selectedAsset.issuer
                  : truncateIssuer(selectedAsset.issuer)}
              </span>
            )}
          </span>
        </span>

        <span className="flex items-center gap-2">
          <span className="text-xs text-gray-400">
            {loading ? "..." : balance}
          </span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className={cn(
              "w-4 h-4 text-gray-400 transition-transform",
              open && "rotate-180",
            )}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.5 8.25l-7.5 7.5-7.5-7.5"
            />
          </svg>
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-xl py-1 animate-fade-in max-h-96 overflow-y-auto">
            {allAssets.map((asset) => {
              const bal = findAssetBalance(balances, asset);
              const key = `${asset.code}:${asset.issuer ?? "native"}`;
              const tl = trustlineStatus[key];

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleSelect(asset)}
                  className={cn(
                    "w-full flex items-center justify-between px-4 py-2.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors",
                    selectedAsset.code === asset.code &&
                      selectedAsset.issuer === asset.issuer &&
                      "bg-ophir-50 dark:bg-ophir-950/20",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-ophir-100 dark:bg-ophir-900/30 flex items-center justify-center text-xs font-bold text-ophir-700 dark:text-ophir-300">
                      {asset.code.slice(0, 2)}
                    </span>
                    <div className="text-left">
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-900 dark:text-white font-medium">
                          {asset.code}
                        </span>
                        {asset.displayName && asset.displayName !== asset.code && (
                          <span className="text-xs text-gray-500 dark:text-gray-400 font-normal">
                            ({asset.displayName})
                          </span>
                        )}
                        {asset.domain && (
                          <span className="text-[10px] bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded font-normal">
                            {asset.domain}
                          </span>
                        )}
                      </div>
                      {asset.issuer ? (
                        <span
                          className="block text-[10px] text-gray-400 font-mono"
                          title={asset.issuer}
                        >
                          Issuer: {truncateIssuer(asset.issuer)}
                        </span>
                      ) : (
                        <span className="block text-xs text-gray-400">
                          {asset.displayName}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {bal}
                    </span>
                    {asset.type !== "native" && (
                      <span
                        className={cn(
                          "block text-xs",
                          tl?.checking
                            ? "text-gray-400"
                            : tl?.state === "authorized"
                              ? "text-green-500"
                              : tl?.state === "frozen" || tl?.state === "unauthorized"
                                ? "text-red-500"
                                : tl?.state === "unavailable"
                                  ? "text-gray-400"
                                : "text-amber-500",
                        )}
                      >
                        {tl?.checking
                          ? "checking..."
                          : tl?.state === "authorized"
                            ? "✓ authorized"
                            : tl?.state === "frozen"
                              ? "frozen"
                              : tl?.state === "unauthorized"
                                ? "not authorized"
                                : tl?.state === "unavailable"
                                  ? "status unavailable"
                                : "no trustline"}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}

            {selectedAsset.type !== "native" && selectedAsset.issuer && trustlineStatus[`${selectedAsset.code}:${selectedAsset.issuer}`]?.state && (
              <div className="border-t border-gray-100 dark:border-gray-700 mt-1 px-4 py-3">
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  {getTrustlineMessage(trustlineStatus[`${selectedAsset.code}:${selectedAsset.issuer}`].state!, selectedAsset.code)}
                </p>
                {trustlineStatus[`${selectedAsset.code}:${selectedAsset.issuer}`].state === "missing" && (
                  <>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Creating a trustline lets this account hold the asset and requires additional XLM for the network reserve (currently 0.5 XLM), plus a small transaction fee.
                    </p>
                    {trustlineError && <p role="alert" className="text-xs text-red-600 mt-2">{trustlineError}</p>}
                    <button
                      type="button"
                      onClick={() => handleSetupTrustline(selectedAsset)}
                      disabled={settingUpTrustline || !publicKey}
                      className="mt-3 px-3 py-2 rounded-lg bg-ophir-600 text-white text-xs font-semibold disabled:opacity-50"
                    >
                      {settingUpTrustline ? "Waiting for wallet…" : "Set up trustline"}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Custom token input & resolution */}
            <div className="border-t border-gray-100 dark:border-gray-700 mt-1 pt-2 px-3 pb-2">
              {!showCustomInput ? (
                <button
                  type="button"
                  onClick={() => setShowCustomInput(true)}
                  className="w-full text-xs text-left text-ophir-600 dark:text-ophir-400 hover:underline py-1 cursor-pointer"
                >
                  + Add custom asset
                </button>
              ) : (
                <form onSubmit={handleAddCustomAsset} className="space-y-2 mt-1">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Code (e.g. AQUA)"
                      value={customCode}
                      onChange={(e) => setCustomCode(e.target.value.toUpperCase())}
                      className="w-1/3 px-2 py-1 text-xs border rounded bg-transparent border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white uppercase"
                      maxLength={12}
                      required
                    />
                    <input
                      type="text"
                      placeholder="Issuer (G... address)"
                      value={customIssuer}
                      onChange={(e) => setCustomIssuer(e.target.value.trim())}
                      className="w-2/3 px-2 py-1 text-xs border rounded bg-transparent border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white font-mono"
                    />
                  </div>
                  {resolveError && (
                    <p className="text-[11px] text-red-500">{resolveError}</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setShowCustomInput(false);
                        setResolveError(null);
                      }}
                      className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 px-2 py-1 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={resolvingCustom || !customCode.trim()}
                      className="text-xs px-2.5 py-1 bg-ophir-600 text-white rounded hover:bg-ophir-700 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                    >
                      {resolvingCustom ? "Resolving..." : "Select Asset"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
