"use client";
// SPDX-License-Identifier: MIT

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { formatAmount, shortenAddress } from "@/lib/utils";

interface BatchRecipient {
  address: string;
  amount: string;
}

export interface BatchConfirmDialogProps {
  open: boolean;
  recipients: BatchRecipient[];
  totalAmount: number;
  estimatedFee: string;
  feeBasis?: "live" | "cached" | "configured";
  networkCongestion?: "low" | "medium" | "high";
  feeExplanation?: string;
  isFallback?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const MAX_VISIBLE = 5;

export function BatchConfirmDialog({
  open,
  recipients,
  totalAmount,
  estimatedFee,
  feeBasis,
  networkCongestion,
  feeExplanation,
  isFallback,
  onConfirm,
  onCancel,
}: BatchConfirmDialogProps) {
  const visibleRecipients = recipients.slice(0, MAX_VISIBLE);
  const remainingCount = recipients.length - MAX_VISIBLE;
  const feeXlm = formatAmount(parseFloat(estimatedFee) / 10000000, "XLM");

  return (
    <Modal open={open} onClose={onCancel} title="Confirm Batch Payment" size="md">
      <div className="space-y-4">
        {/* Summary */}
        <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 p-3 sm:p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500 dark:text-gray-400">Recipients</span>
            <span className="font-medium text-gray-900 dark:text-white">{recipients.length}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500 dark:text-gray-400">Total Amount</span>
            <span className="font-semibold text-gray-900 dark:text-white">{formatAmount(totalAmount, "XLM")}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500 dark:text-gray-400">Estimated Fee</span>
            <div className="text-right">
              <span className="font-medium text-gray-900 dark:text-white">{feeXlm}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 block font-mono">
                (~{estimatedFee} stroops)
              </span>
            </div>
          </div>

          {feeBasis && (
            <div
              className="flex justify-between items-center text-sm pt-2 border-t border-gray-100 dark:border-gray-800"
              data-testid="batch-fee-basis-row"
            >
              <span className="text-gray-500 dark:text-gray-400">Fee Basis</span>
              <div className="flex items-center gap-1.5">
                <span
                  data-testid="batch-fee-basis-badge"
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    feeBasis === "live"
                      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                  }`}
                >
                  {feeBasis === "live"
                    ? "Live stats"
                    : feeBasis === "cached"
                      ? "Cached fallback"
                      : "Configured fallback"}
                </span>
                {networkCongestion && (
                  <span
                    data-testid="batch-congestion-badge"
                    className={`px-1.5 py-0.5 rounded-full text-xs font-medium ${
                      networkCongestion === "low"
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : networkCongestion === "medium"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                          : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                    }`}
                  >
                    {networkCongestion}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Fallback Warning */}
        {isFallback && (
          <div
            data-testid="batch-fallback-warning"
            className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2"
          >
            <span className="text-sm leading-none">⚠️</span>
            <span>
              Horizon is unreachable. Fee estimated using {feeBasis === "cached" ? "cached statistics from the last known ledger" : "configured network base fee"}.
            </span>
          </div>
        )}

        {/* Elevated Congestion Explanation */}
        {feeExplanation && networkCongestion && networkCongestion !== "low" && (
          <div
            data-testid="batch-congestion-explanation"
            className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/50 text-xs text-blue-800 dark:text-blue-300 flex items-start gap-2"
          >
            <span className="text-sm leading-none">ℹ️</span>
            <span>{feeExplanation}</span>
          </div>
        )}

        {/* Recipient list */}
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Recipients</h3>
          <div className="divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            {visibleRecipients.map((r, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-3 py-2.5 sm:py-2 bg-white dark:bg-gray-900"
              >
                <span className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate">
                  {shortenAddress(r.address, 8)}
                </span>
                <span className="text-xs font-mono font-semibold text-gray-900 dark:text-white ml-3">
                  {formatAmount(parseFloat(r.amount), "XLM")}
                </span>
              </div>
            ))}
          </div>
          {remainingCount > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
              …and {remainingCount} more
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row justify-end gap-3 pt-2">
          <Button variant="outline" onClick={onCancel} className="w-full sm:w-auto min-h-[44px]">
            Back
          </Button>
          <Button variant="primary" onClick={onConfirm} data-testid="batch-confirm-send" className="w-full sm:w-auto min-h-[44px]">
            Confirm & Sign
          </Button>
        </div>
      </div>
    </Modal>
  );
}
