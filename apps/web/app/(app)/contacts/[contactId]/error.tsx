'use client';

import { RouteErrorFallback } from '@/components/ui/RouteErrorFallback';

/**
 * The contact route's error boundary.
 *
 * A contact the reader may not open does **not** reach here — that is
 * `not_found`, which `loadContactProfile` returns as a state so the page can
 * explain it rather than offering a retry that could never work.
 */
export default function ContactError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} label="Contact route failed" />;
}
