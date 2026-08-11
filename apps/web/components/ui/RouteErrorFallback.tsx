'use client';

import { useEffect } from 'react';
import { ErrorState } from './ErrorState';
import { PageShell } from '@/components/shell/PageShell';

/**
 * The body of a route-level `error.tsx`. Usage:
 * `<RouteErrorFallback error={error} reset={reset} label="Inbox route failed" />`.
 *
 * Extracted because there are two of these boundaries at the top of the tree and
 * they must behave identically: one inside the app shell, so a failed page keeps
 * its navigation, and one above both route groups for anything that fails outside
 * a shell. The only difference between them is the landmark, which is the
 * caller's to provide.
 */
export function RouteErrorFallback({
  error,
  reset,
  label,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Names the boundary in the log line, so two reports are distinguishable. */
  label: string;
}) {
  useEffect(() => {
    // Never swallowed. TAR-41 wires the error tracker; the digest is what
    // correlates this with the server log line.
    console.error(label, error.digest ?? error.message);
  }, [error, label]);

  return (
    <PageShell>
      <ErrorState onRetry={reset} requestId={error.digest ?? null} />
    </PageShell>
  );
}
