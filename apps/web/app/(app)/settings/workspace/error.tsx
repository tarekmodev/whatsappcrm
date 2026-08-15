'use client';

import { RouteErrorFallback } from '@/components/ui/RouteErrorFallback';

/**
 * The route-level error boundary. The sections inside have their own
 * `SectionErrorBoundary` and the profile form has a third from `LazyBoundary`,
 * so reaching this one means the page itself failed — resolving the session,
 * most likely.
 */
export default function WorkspaceSettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} label="Workspace settings route failed" />;
}
