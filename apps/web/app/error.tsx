'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageShell } from '@/components/shell/PageShell';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';

/**
 * The app-wide error boundary — the last one before the browser shows nothing.
 * Individual routes and sections have their own, so reaching this means the failure
 * was outside all of them.
 *
 * It renders its own `<main>`: this boundary replaces every layout below `<body>`,
 * including the two route-group shells that own the landmark, so without one the
 * page a user lands on at their worst moment has no landmarks at all.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled application error', error.digest ?? error.message);
  }, [error]);

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1}>
      <PageShell>
        <ErrorState onRetry={reset} requestId={error.digest ?? null} />
      </PageShell>
    </main>
  );
}
