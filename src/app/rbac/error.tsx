"use client";
// SPDX-License-Identifier: MIT

import { SegmentErrorFallback } from "@/components/SegmentErrorFallback";

export default function RbacError({
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
      segmentName="rbac"
      segmentTitle="Role-Based Access Control"
    />
  );
}
