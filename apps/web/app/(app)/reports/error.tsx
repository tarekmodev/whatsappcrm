'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * The route-level error boundary. The dashboard's sections have their own
 * `SectionErrorBoundary`, so reaching this one means the page itself failed —
 * the session read, or the range parse before anything was fetched.
 */
export default function ReportsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Never swallowed. The digest is what correlates this with the server log
    // line, and with the `requestId` on a timed-out report — ADR 0010
    // (reporting dashboard and export).
    console.error('Reports route failed', error.digest ?? error.message);
  }, [error]);

  return <ErrorState onRetry={reset} requestId={error.digest ?? null} />;
}
