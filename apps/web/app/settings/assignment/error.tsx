'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';

/** Route-level error boundary for the assignment report. */
export default function AssignmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Assignment route failed', error.digest ?? error.message);
  }, [error]);

  return <ErrorState onRetry={reset} requestId={error.digest ?? null} />;
}
