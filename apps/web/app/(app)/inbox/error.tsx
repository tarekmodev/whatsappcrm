'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageShell } from '@/components/shell/PageShell';

/** Route-level error boundary for the inbox. */
export default function InboxError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Inbox route failed', error.digest ?? error.message);
  }, [error]);

  return (
    <PageShell>
      <ErrorState onRetry={reset} requestId={error.digest ?? null} />
    </PageShell>
  );
}
