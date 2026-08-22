'use client';

import { RouteErrorFallback } from '@/components/ui/RouteErrorFallback';

/**
 * The route-level error boundary. The sections inside have their own
 * `SectionErrorBoundary` and the form has a third from `LazyBoundary`, so
 * reaching this one means the page itself failed — resolving the session, most
 * likely.
 */
export default function SlaSettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} label="Response deadlines route failed" />;
}
