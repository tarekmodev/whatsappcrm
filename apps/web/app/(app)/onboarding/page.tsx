import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { parseOnboardingStep, searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { requirePermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { PageShell } from '@/components/shell/PageShell';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { OnboardingBoundary } from '@/features/onboarding/components/OnboardingBoundary';
import {
  OnboardingSection,
  OnboardingSectionSkeleton,
} from '@/features/onboarding/components/OnboardingSection';

/**
 * The guided onboarding checklist a new tenant admin lands in after signup, and
 * returns to whenever they want to pick up a step they skipped (TAR-36, TAR-407).
 *
 * Composition only: gate, header, then the section behind its own boundary and
 * its own skeleton.
 *
 * Gated on `tenant:settings` — the permission the checklist endpoints require —
 * so a principal without it gets a real 403 state rather than a page whose every
 * call the API would refuse. `NAV_ITEMS` hides the entry for the same principals.
 * Both are UX: the API enforces it.
 */

export const metadata: Metadata = {
  title: `${content.onboarding.title} · ${content.app.name}`,
  description: content.onboarding.subtitle,
};

/** Resolves a live session and a per-tenant checklist; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const session = await requirePermission('tenant:settings');

  if (session === null) {
    return <ForbiddenState />;
  }

  const params = await searchParams;
  const requestedStepId = parseOnboardingStep(
    firstSearchParam(params[searchParamKeys.onboardingStep]),
  );

  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.onboarding.title} subtitle={content.onboarding.subtitle} />
        <OnboardingBoundary>
          {/* Keyed on the open step so moving between steps shows the skeleton
              again rather than leaving the previous step's panel on screen. */}
          <Suspense key={requestedStepId ?? ''} fallback={<OnboardingSectionSkeleton />}>
            <OnboardingSection requestedStepId={requestedStepId} />
          </Suspense>
        </OnboardingBoundary>
      </Stack>
    </PageShell>
  );
}
