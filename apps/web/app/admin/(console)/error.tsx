'use client';

import { RouteErrorFallback } from '@/components/ui/RouteErrorFallback';

/**
 * The operator console's route boundary. It sits *inside* the shell, so a failed
 * screen keeps its navigation and the operator can go somewhere else — which
 * matters more here than on a tenant screen: the alternative to a working console
 * is psql against production.
 */
export default function PlatformAdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} label="Platform admin route failed" />;
}
