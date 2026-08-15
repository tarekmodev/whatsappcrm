import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { PageShell } from '@/components/shell/PageShell';
import { OnboardingSectionSkeleton } from '@/features/onboarding/components/OnboardingSection';

/**
 * The route-level skeleton. Composed from the page's own section skeleton, in the
 * same shell with the same header and the same gap, so arriving here does not
 * reflow when the real page lands.
 */
export default function OnboardingLoading() {
  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.onboarding.title} subtitle={content.onboarding.subtitle} />
        <OnboardingSectionSkeleton />
      </Stack>
    </PageShell>
  );
}
