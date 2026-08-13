'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';

/**
 * The ticket route's error boundary.
 *
 * A ticket the reader may not open does **not** reach here — that is
 * `not_found`, which `loadTicketDetail` returns as a state so the page can
 * explain it rather than offering a retry that could never work.
 */
export default function TicketError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Ticket route failed', error.digest ?? error.message);
  }, [error]);

  return <ErrorState onRetry={reset} requestId={error.digest ?? null} />;
}
