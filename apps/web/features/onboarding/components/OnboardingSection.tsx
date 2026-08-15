import type { OnboardingStepId } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { getOnboardingChecklist } from '@/lib/api/onboarding';
import { SectionCard } from '@/components/ui/SectionCard';
import { OnboardingChecklist, OnboardingChecklistSkeleton } from './OnboardingChecklist';

/**
 * Fetches the checklist and puts it in the page's one card. Usage: inside a
 * Suspense boundary on the onboarding page, with `OnboardingSectionSkeleton` as
 * the fallback.
 *
 * A server component, so the read, the session it is scoped by and the whole
 * walkthrough's markup stay off the client bundle — only the skip control ships.
 */
export async function OnboardingSection({
  requestedStepId,
}: {
  requestedStepId?: OnboardingStepId;
}) {
  const checklist = await getOnboardingChecklist();

  return (
    <SectionCard
      id="onboarding-checklist"
      title={content.onboarding.checklistHeading}
      description={content.onboarding.checklistDescription}
    >
      <OnboardingChecklist checklist={checklist} requestedStepId={requestedStepId} />
    </SectionCard>
  );
}

/** The same card with the same heading, holding the checklist's own skeleton. */
export function OnboardingSectionSkeleton() {
  return (
    <SectionCard
      id="onboarding-checklist"
      title={content.onboarding.checklistHeading}
      description={content.onboarding.checklistDescription}
    >
      <OnboardingChecklistSkeleton />
    </SectionCard>
  );
}
