'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';

/** Route-level error boundary for the workflow builder. */
export default function WorkflowsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Workflows route failed', error.digest ?? error.message);
  }, [error]);

  return <ErrorState onRetry={reset} requestId={error.digest ?? null} />;
}
