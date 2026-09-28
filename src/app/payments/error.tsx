"use client";
// SPDX-License-Identifier: MIT

import { SegmentErrorFallback } from "@/components/SegmentErrorFallback";

export default function PaymentsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <SegmentErrorFallback
      error={error}
      reset={reset}
      segmentName="payments"
      segmentTitle="Payments"
    />
  );
}
