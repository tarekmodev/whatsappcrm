'use client';

import { RouteErrorFallback } from '@/components/ui/RouteErrorFallback';

/**
 * The route-level error boundary. The section inside has its own
 * `SectionErrorBoundary`, so reaching this one means the page itself failed —
 * resolving the session, most likely.
 */
export default function SecurityError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} label="Security route failed" />;
}
