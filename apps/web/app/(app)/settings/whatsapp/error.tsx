'use client';

import { RouteErrorFallback } from '@/components/ui/RouteErrorFallback';

/**
 * The route-level error boundary. The section inside has its own
 * `SectionErrorBoundary` and the panel has a third from `LazyBoundary`, so
 * reaching this one means the page itself failed — resolving the session, most
 * likely.
 */
export default function WhatsAppSettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} label="WhatsApp settings route failed" />;
}
