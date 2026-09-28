"use client";
// SPDX-License-Identifier: MIT

import { useState, useEffect, useCallback } from "react";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Card } from "@/components/ui/Card";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";
import { useApiQuery } from "@/hooks/useApiQuery";
import {
  API_SCOPES,
  type ApiScope,
} from "@/lib/api-scopes";
import { useToast } from "@/components/ui/Toast";
import { CopyButton } from "@/components/ui/CopyButton";

interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsed: string | null;
  createdAt: string;
  expiresAt: string | null;
  rotatedAt?: string | null;
  rotatedFromId?: string | null;
  rotatedFrom?: { id: string; name: string; prefix: string } | null;
  rotations?: Array<{
    id: string;
    name: string;
    prefix: string;
    createdAt: string;
    expiresAt: string | null;
  }>;
}

interface KeyUsage {
  id: string;
  name: string;
  prefix: string;
  lastUsed: string | null;
  createdAt: string;
  expiresAt: string | null;
  total: number;
  window: number;
}

interface KeyStatsResponse {
  window: string;
  keys: KeyUsage[];
}

const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "read:payments": "View payments and payment history",
  "write:payments": "Create and submit payments",
  "read:analytics": "Read analytics and reporting data",
  admin: "Full access to all API capabilities",
};

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function ApiKeysPage() {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form
  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<ApiScope[]>([]);
  const [creating, setCreating] = useState(false);
  const [newRawKey, setNewRawKey] = useState<string | null>(null);

  // Edit panel
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editScopes, setEditScopes] = useState<ApiScope[]>([]);

  // Rotate panel & state
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [overlapHours, setOverlapHours] = useState(24);
  const [rotating, setRotating] = useState(false);
  const [rotatedResult, setRotatedResult] = useState<{
    newKey: { key: string; prefix: string; name: string };
    overlapExpiresAt: string;
  } | null>(null);

  // Usage-stats window
  const [window, setWindow] = useState("30d");

  const { data: usage, isLoading: usageLoading, error: usageError } = useApiQuery<KeyStatsResponse>(
    ["api-keys", "stats", window],
    `/api/keys/stats?window=${window}`
  );

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/keys", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load keys");
      const data = await res.json();
      setKeys(data.data ?? []);
    } catch {
      toast.error("Could not load API keys", "Please try again.");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const toggleScope = (
    scope: ApiScope,
    current: ApiScope[],
    set: (s: ApiScope[]) => void
  ) => {
    set(
      current.includes(scope)
        ? current.filter((s) => s !== scope)
        : [...current, scope]
    );
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error("Name required", "Please name your API key.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes: selectedScopes }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message ?? "Failed to create key");
      }
      setNewRawKey(data.data.key);
      setName("");
      setSelectedScopes([]);
      toast.success("API key created", "Copy it now — it won't be shown again.");
      loadKeys();
    } catch (err) {
      toast.error(
        "Creation failed",
        err instanceof Error ? err.message : "Unknown error"
      );
    } finally {
      setCreating(false);
    }
  };

  const handleSaveScopes = async (id: string) => {
    try {
      const res = await fetch("/api/keys", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, scopes: editScopes }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message ?? "Failed to update scopes");
      }
      toast.success("Scopes updated", "The key's permissions were saved.");
      setEditingId(null);
      loadKeys();
    } catch (err) {
      toast.error(
        "Update failed",
        err instanceof Error ? err.message : "Unknown error"
      );
    }
  };

  const handleRotate = async (id: string) => {
    setRotating(true);
    try {
      const res = await fetch("/api/keys/rotate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, overlapHours }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message ?? "Failed to rotate key");
      }
      setRotatedResult({
        newKey: data.data.newKey,
        overlapExpiresAt: data.data.overlapExpiresAt,
      });
      setRotatingId(null);
      toast.success(
        "API key rotated",
        "New key generated! Both keys authenticate during the overlap window."
      );
      loadKeys();
    } catch (err) {
      toast.error(
        "Rotation failed",
        err instanceof Error ? err.message : "Unknown error"
      );
    } finally {
      setRotating(false);
    }
  };

  const handleConfirmCutover = async (id: string) => {
    try {
      const res = await fetch("/api/keys/rotate/confirm", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message ?? "Failed to confirm cutover");
      }
      toast.success("Cutover confirmed", "The old key has been expired immediately.");
      loadKeys();
    } catch (err) {
      toast.error(
        "Cutover failed",
        err instanceof Error ? err.message : "Unknown error"
      );
    }
  };

  const handleCancelRotation = async (id: string) => {
    try {
      const res = await fetch("/api/keys/rotate/cancel", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message ?? "Failed to cancel rotation");
      }
      toast.success("Rotation cancelled", "Replacement key revoked and original key restored.");
      loadKeys();
    } catch (err) {
      toast.error(
        "Cancellation failed",
        err instanceof Error ? err.message : "Unknown error"
      );
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/keys?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete key");
      toast.success("Key revoked", "The API key can no longer be used.");
      loadKeys();
    } catch {
      toast.error("Delete failed", "Please try again.");
    }
  };

  const openEdit = (key: ApiKeyRecord) => {
    setEditingId(key.id);
    setEditScopes(key.scopes as ApiScope[]);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <Breadcrumb items={[{ label: "API Keys" }]} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">API Keys</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            Create keys with scoped permissions and monitor per-key request usage
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          Window
          <select value={window} onChange={(event) => setWindow(event.target.value)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </label>
      </div>

      {/* Request usage */}
      <Card padding="none">
        {usageLoading ? <LoadingSkeleton variant="table" /> : usageError ? (
          <div className="p-6 text-sm text-red-600 dark:text-red-400">Failed to load API key usage: {usageError.message}</div>
        ) : usage?.keys.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900/50 dark:text-gray-400">
                <tr><th className="px-6 py-3 font-medium">Key</th><th className="px-6 py-3 font-medium">Requests ({usage.window})</th><th className="px-6 py-3 font-medium">All time</th><th className="px-6 py-3 font-medium">Last used</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {usage.keys.map((key) => <tr key={key.id} className="text-gray-700 dark:text-gray-300">
                  <td className="px-6 py-4"><div className="font-medium text-gray-900 dark:text-white">{key.name}</div><div className="font-mono text-xs text-gray-500">{key.prefix}...</div></td>
                  <td className="px-6 py-4 font-semibold text-ophir-700 dark:text-ophir-400">{key.window.toLocaleString()}</td>
                  <td className="px-6 py-4">{key.total.toLocaleString()}</td>
                  <td className="px-6 py-4 whitespace-nowrap">{formatDate(key.lastUsed)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        ) : <div className="p-10 text-center text-sm text-gray-500 dark:text-gray-400">No API keys yet.</div>}
      </Card>

      {/* Create card */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Create a new API key
        </h2>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Production server"
            className="w-full px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 text-sm focus:outline-none focus:ring-2 focus:ring-ophir-500"
          />
        </div>

        <div>
          <p className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Scopes
          </p>
          <div className="grid sm:grid-cols-2 gap-2">
            {API_SCOPES.map((scope) => {
              const checked = selectedScopes.includes(scope);
              return (
                <label
                  key={scope}
                  className="flex items-start gap-2.5 p-3 rounded-lg border border-gray-200 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      toggleScope(scope, selectedScopes, setSelectedScopes)
                    }
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-ophir-600 focus:ring-ophir-500"
                  />
                  <span className="text-sm">
                    <span className="font-mono font-medium text-gray-800 dark:text-gray-200">
                      {scope}
                    </span>
                    <span className="block text-gray-500 dark:text-gray-400">
                      {SCOPE_DESCRIPTIONS[scope]}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            No scopes selected means the key cannot call any scoped endpoint.
            The <span className="font-mono">admin</span> scope grants everything.
          </p>
        </div>

        <button
          onClick={handleCreate}
          disabled={creating}
          className="px-5 py-2.5 rounded-lg bg-ophir-600 text-white text-sm font-medium hover:bg-ophir-700 transition-colors disabled:opacity-50"
        >
          {creating ? "Creating..." : "Create API key"}
        </button>

        {newRawKey && (
          <div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
            <p className="text-sm text-green-700 dark:text-green-400 font-medium mb-2">
              Key created — copy it now:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all text-xs font-mono text-gray-800 dark:text-gray-200 bg-white dark:bg-gray-900 p-2 rounded">
                {newRawKey}
              </code>
              <CopyButton value={newRawKey} label="Key" />
            </div>
          </div>
        )}

        {rotatedResult && (
          <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm text-amber-800 dark:text-amber-300 font-semibold">
                Key rotated successfully (Zero Downtime)
              </p>
              <button
                onClick={() => setRotatedResult(null)}
                className="text-xs text-amber-700 dark:text-amber-400 hover:underline"
              >
                Dismiss
              </button>
            </div>
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Copy your replacement key now. Both keys will authenticate simultaneously until the overlap window closes on{" "}
              <span className="font-semibold">{formatDate(rotatedResult.overlapExpiresAt)}</span>.
            </p>
            <div className="flex items-center gap-2 pt-1">
              <code className="flex-1 break-all text-xs font-mono text-gray-800 dark:text-gray-200 bg-white dark:bg-gray-900 p-2 rounded border border-amber-200 dark:border-amber-800">
                {rotatedResult.newKey.key}
              </code>
              <CopyButton value={rotatedResult.newKey.key} label="Key" />
            </div>
          </div>
        )}
      </div>

      {/* List */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Your API keys
        </h2>

        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            You have no API keys yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {keys.map((key) => {
              const nowMs = Date.now();
              const expiresAtMs = key.expiresAt ? new Date(key.expiresAt).getTime() : null;
              const isRotating = !!key.rotatedAt && expiresAtMs !== null && expiresAtMs > nowMs;
              const isRotatedExpired = !!key.rotatedAt && expiresAtMs !== null && expiresAtMs <= nowMs;
              const isStandardExpired = !key.rotatedAt && expiresAtMs !== null && expiresAtMs <= nowMs;
              const isReplacement = !!key.rotatedFromId;

              return (
                <li
                  key={key.id}
                  className="rounded-lg border border-gray-200 dark:border-gray-800 p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-gray-900 dark:text-white">
                          {key.name}
                        </p>
                        {isRotating && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-300 dark:border-amber-800 flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                            In rotation · Overlap ends {formatDate(key.expiresAt)}
                          </span>
                        )}
                        {isRotatedExpired && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400 border border-gray-300 dark:border-gray-700">
                            Rotated & expired
                          </span>
                        )}
                        {isStandardExpired && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300">
                            Expired
                          </span>
                        )}
                        {isReplacement && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-cyan-100 text-cyan-800 dark:bg-cyan-950/50 dark:text-cyan-300">
                            Rotated from {key.rotatedFrom?.prefix ?? "parent"}...
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-mono text-gray-500 dark:text-gray-400 mt-0.5">
                        {key.prefix}… · created{" "}
                        {new Date(key.createdAt).toLocaleDateString()}
                        {key.lastUsed
                          ? ` · last used ${new Date(key.lastUsed).toLocaleDateString()}`
                          : ""}
                      </p>
                      {isRotating && key.rotations && key.rotations.length > 0 && (
                        <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                          ↳ Replacement key: <span className="font-mono">{key.rotations[0]?.prefix}...</span> ({key.rotations[0]?.name})
                        </p>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {key.scopes.length === 0 ? (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                            no scopes
                          </span>
                        ) : (
                          key.scopes.map((s) => (
                            <span
                              key={s}
                              className="px-2 py-0.5 rounded-full text-xs font-medium bg-ophir-100 text-ophir-700 dark:bg-ophir-950/50 dark:text-ophir-300"
                            >
                              {s}
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 shrink-0">
                      {isRotating ? (
                        <>
                          <button
                            onClick={() => handleConfirmCutover(key.id)}
                            className="px-3 py-1.5 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 text-xs font-medium hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
                            title="Expire old key immediately once replacement is deployed"
                          >
                            Confirm cutover
                          </button>
                          <button
                            onClick={() => handleCancelRotation(key.id)}
                            className="px-3 py-1.5 rounded-lg border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 text-xs font-medium hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors"
                            title="Cancel rotation, delete replacement key and keep this key active"
                          >
                            Cancel rotation
                          </button>
                        </>
                      ) : (
                        !isRotatedExpired && !isStandardExpired && (
                          <button
                            onClick={() => {
                              setRotatingId(key.id);
                              setEditingId(null);
                            }}
                            className="px-3 py-1.5 rounded-lg border border-ophir-300 dark:border-ophir-700 text-ophir-700 dark:text-ophir-300 text-xs font-medium hover:bg-ophir-50 dark:hover:bg-ophir-950/30 transition-colors"
                          >
                            Rotate
                          </button>
                        )
                      )}
                      <button
                        onClick={() => openEdit(key)}
                        className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-xs font-medium hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        Edit scopes
                      </button>
                      <button
                        onClick={() => handleDelete(key.id)}
                        className="px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-xs font-medium hover:bg-red-50 dark:hover:bg-red-950/30"
                      >
                        Revoke
                      </button>
                    </div>
                  </div>

                  {/* Inline Rotation Panel */}
                  {rotatingId === key.id && (
                    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-800 space-y-3 bg-gray-50 dark:bg-gray-800/40 p-4 rounded-lg">
                      <div>
                        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
                          Rotate “{key.name}” (Zero-Downtime Secret Rotation)
                        </h4>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Issues a new replacement key with the exact same scopes. Both keys will authenticate simultaneously
                          during the configured overlap window so your live integrations experience zero downtime.
                        </p>
                      </div>

                      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                        <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
                          Overlap window:
                        </label>
                        <select
                          value={overlapHours}
                          onChange={(e) => setOverlapHours(Number(e.target.value))}
                          className="text-xs rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900 text-gray-900 dark:text-white"
                        >
                          <option value={1}>1 hour</option>
                          <option value={12}>12 hours</option>
                          <option value={24}>24 hours (default)</option>
                          <option value={48}>48 hours</option>
                          <option value={168}>7 days</option>
                        </select>
                      </div>

                      <div className="flex gap-2">
                        <button
                          onClick={() => handleRotate(key.id)}
                          disabled={rotating}
                          className="px-4 py-2 rounded-lg bg-ophir-600 text-white text-xs font-medium hover:bg-ophir-700 disabled:opacity-50 transition-colors"
                        >
                          {rotating ? "Generating key..." : "Confirm & Generate Replacement Key"}
                        </button>
                        <button
                          onClick={() => setRotatingId(null)}
                          className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-xs font-medium hover:bg-gray-100 dark:hover:bg-gray-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Inline Scope Edit Panel */}
                  {editingId === key.id && (
                    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-800 space-y-3">
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Effective scopes for “{key.name}”
                      </p>
                      <div className="grid sm:grid-cols-2 gap-2">
                        {API_SCOPES.map((scope) => {
                          const checked = editScopes.includes(scope);
                          return (
                            <label
                              key={scope}
                              className="flex items-start gap-2.5 p-2.5 rounded-lg border border-gray-200 dark:border-gray-700 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  toggleScope(scope, editScopes, setEditScopes)
                                }
                                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-ophir-600 focus:ring-ophir-500"
                              />
                              <span className="text-sm font-mono text-gray-800 dark:text-gray-200">
                                {scope}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleSaveScopes(key.id)}
                          className="px-4 py-2 rounded-lg bg-ophir-600 text-white text-xs font-medium hover:bg-ophir-700"
                        >
                          Save scopes
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-xs font-medium"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Rotation & Audit Trail Info Card */}
      <Card>
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <span>🛡️</span> Zero-Downtime Secret Rotation & Audit Trail
          </h3>
          <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
            API key rotation issues a replacement key with identical scopes and establishes a configurable overlap window
            (default 24h). During the overlap window, both keys authenticate seamlessly. Once the window closes, the old
            key is automatically rejected with an explicit rotation reason. You can also explicitly confirm cutover once
            your new key is deployed, or cancel the rotation at any time during the overlap. Every rotation, cutover, and
            revocation is permanently recorded in the system audit trail.
          </p>
        </div>
      </Card>
    </div>
  );
}
