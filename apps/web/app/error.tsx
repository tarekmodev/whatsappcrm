'use client';

import { RouteErrorFallback } from '@/components/ui/RouteErrorFallback';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';

/**
 * The app-wide error boundary — the last one before the browser shows nothing.
 * Reaching it means the failure was outside both route groups and outside every
 * boundary inside them, so it renders its own `<main>`: the shell that normally
 * provides the landmark is exactly what did not render.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1}>
      <RouteErrorFallback error={error} reset={reset} label="Unhandled application error" />
    </main>
  );
}
