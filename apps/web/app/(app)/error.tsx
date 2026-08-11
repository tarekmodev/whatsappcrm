'use client';

import { RouteErrorFallback } from '@/components/ui/RouteErrorFallback';

/**
 * The console's error boundary. It sits *inside* the app shell, so a failed page
 * keeps its header and navigation and the user can go somewhere else instead of
 * being left on a dead screen with a retry button.
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} label="Console route failed" />;
}
