'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * The route-level error boundary. Sections inside the page have their own
 * `SectionErrorBoundary`, so reaching this one means the page itself failed.
 */
export default function PeopleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Never swallowed. TAR-41 wires the error tracker; the digest is what
    // correlates this with the server log line.
    console.error('People route failed', error.digest ?? error.message);
  }, [error]);

  return <ErrorState onRetry={reset} requestId={error.digest ?? null} />;
}
