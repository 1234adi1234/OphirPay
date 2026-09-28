"use client";
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import { reportRenderedError } from "@/lib/analytics-events";

interface SegmentErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  segmentName: string;
  segmentTitle?: string;
}

export function SegmentErrorFallback({
  error,
  reset,
  segmentName,
  segmentTitle,
}: SegmentErrorProps) {
  const displayTitle = segmentTitle || segmentName.charAt(0).toUpperCase() + segmentName.slice(1);

  useEffect(() => {
    console.error(`[OphirPay ${displayTitle} Error]:`, error);
    reportRenderedError(error, undefined, segmentName);
  }, [error, segmentName, displayTitle]);

  return (
    <div
      data-testid={`segment-error-${segmentName}`}
      className="w-full py-12 px-4 flex items-center justify-center animate-fade-in"
    >
      <div className="max-w-lg w-full bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 shadow-sm text-center">
        <div className="h-14 w-14 mx-auto rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className="w-7 h-7 text-amber-600 dark:text-amber-400"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
        </div>

        <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
          Unable to load {displayTitle}
        </h3>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          {error.message || `An error occurred while rendering the ${segmentName} section. You can still navigate to other parts of OphirPay.`}
        </p>

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-ophir-600 hover:bg-ophir-700 text-white text-sm font-medium transition-colors shadow-sm"
          >
            Retry {displayTitle}
          </button>
        </div>
      </div>
    </div>
  );
}
