"use client";
// SPDX-License-Identifier: MIT

import { SegmentErrorFallback } from "@/components/SegmentErrorFallback";

export default function MultisigError({
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
      segmentName="multisig"
      segmentTitle="Multisig Management"
    />
  );
}
