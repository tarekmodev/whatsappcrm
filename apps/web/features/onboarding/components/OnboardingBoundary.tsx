'use client';

import type { ReactNode } from 'react';
import { content } from '@/content/en';
import { ErrorState } from '@/components/ui/ErrorState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';

/**
 * Keeps a failed checklist read from blanking the onboarding page. Usage: around
 * the Suspense boundary that holds `OnboardingSection`.
 *
 * The copy is the checklist's own rather than the generic one, because the
 * reassurance is the point: a new admin whose setup list will not load needs to
 * be told that the workspace is fine and that what they have already done is
 * still done — "Something went wrong" invites them to redo it.
 *
 * Its own file for the reason `SlaAlertsBoundary` gives: `fallback` is a
 * function, and a function cannot cross from a Server Component into a Client
 * Component. The page is a server component; this is the client boundary that
 * owns the callback.
 */
export function OnboardingBoundary({ children }: { children: ReactNode }) {
  return (
    <SectionErrorBoundary
      fallback={(retry) => (
        <ErrorState
          heading={content.onboarding.unavailableHeading}
          body={content.onboarding.unavailableBody}
          onRetry={retry}
        />
      )}
    >
      {children}
    </SectionErrorBoundary>
  );
}
