'use client';

import { RouteErrorFallback } from '@/components/ui/RouteErrorFallback';

/**
 * The directory's route-level boundary. The filter bar and the list each have
 * their own `SectionErrorBoundary`, so reaching this one means the page itself
 * failed rather than one of its regions.
 */
export default function ContactsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} label="Contacts route failed" />;
}
