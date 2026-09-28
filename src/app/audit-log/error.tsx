"use client";
// SPDX-License-Identifier: MIT

import { SegmentErrorFallback } from "@/components/SegmentErrorFallback";

export default function AuditLogError({
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
      segmentName="audit-log"
      segmentTitle="Audit Log"
    />
  );
}
