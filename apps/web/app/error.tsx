'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageShell } from '@/components/shell/PageShell';

/**
 * The app-wide error boundary — the last one before the browser shows nothing.
 * Individual routes and sections have their own, so reaching this means the failure
 * was outside all of them.
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
    <PageShell>
      <ErrorState onRetry={reset} requestId={error.digest ?? null} />
    </PageShell>
  );
}
