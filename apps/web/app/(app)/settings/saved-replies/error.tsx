'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * The route-level error boundary. The section inside the page has its own
 * `SectionErrorBoundary`, so reaching this one means the page itself failed.
 */
export default function SavedRepliesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Never swallowed. TAR-41 wires the error tracker; the digest is what
    // correlates this with the server log line.
    console.error('Saved replies route failed', error.digest ?? error.message);
  }, [error]);

  return <ErrorState onRetry={reset} requestId={error.digest ?? null} />;
}
