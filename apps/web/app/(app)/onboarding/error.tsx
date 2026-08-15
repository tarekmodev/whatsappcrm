'use client';

import { RouteErrorFallback } from '@/components/ui/RouteErrorFallback';

/**
 * The route-level error boundary. The checklist inside has its own
 * `SectionErrorBoundary`, so reaching this one means the page itself failed —
 * resolving the session, most likely.
 */
export default function OnboardingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} label="Onboarding route failed" />;
}
