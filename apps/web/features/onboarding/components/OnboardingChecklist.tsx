import {
  ONBOARDING_STEP_IDS,
  nextOnboardingStep,
  onboardingProgress,
  orderedOnboardingSteps,
  type OnboardingChecklistResponse,
  type OnboardingStepId,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { Notice } from '@/components/ui/Notice';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { Stack } from '@/components/layout/Stack';
import {
  OnboardingProgressMeter,
  OnboardingProgressMeterSkeleton,
} from './OnboardingProgressMeter';
import { OnboardingStepItem } from './OnboardingStepItem';
import { OnboardingStepItemSkeleton } from './OnboardingStepItem.Skeleton';
import styles from './OnboardingChecklist.module.css';

/**
 * The walkthrough itself: how far along the tenant is, then the steps. Usage:
 * `<OnboardingChecklist checklist={checklist} requestedStepId={fromTheUrl} />`.
 *
 * An `<ol>`, because the steps have an order and a screen reader should say
 * "2 of 3" without the markup having to spell it out.
 *
 * When every step is resolved the completion notice goes *above* the list rather
 * than replacing it. TAR-36 requires a skipped step to be returnable, and a
 * congratulation that swallows the list takes the way back with it.
 */
export function OnboardingChecklist({
  checklist,
  requestedStepId,
}: {
  checklist: OnboardingChecklistResponse;
  /** From `?step=`, already narrowed. `undefined` opens the first pending step. */
  requestedStepId?: OnboardingStepId;
}) {
  const progress = onboardingProgress(checklist);
  const openStepId = requestedStepId ?? nextOnboardingStep(checklist);

  return (
    <Stack gap="4">
      <OnboardingProgressMeter resolved={progress.resolved} total={progress.total} />
      {progress.isComplete ? (
        <Notice tone="info">{content.onboarding.completeNotice}</Notice>
      ) : null}
      {/* `role="list"`: `list-style: none` drops list semantics in Safari, and
          without them a screen reader stops announcing "2 of 3". */}
      <ol className={styles.list} role="list">
        {orderedOnboardingSteps(checklist).map((step, index) => (
          <OnboardingStepItem
            key={step.id}
            step={step}
            position={index + 1}
            isOpen={step.id === openStepId}
          />
        ))}
      </ol>
    </Stack>
  );
}

/**
 * Mirrors the checklist — same stack, same meter, same list, and the first step
 * open, which is what an admin who has done nothing yet will see. Every step's
 * copy is known ahead of the data, so the only thing that moves on arrival is a
 * status badge.
 */
export function OnboardingChecklistSkeleton() {
  return (
    <Stack gap="4">
      <LoadingAnnouncement label={content.onboarding.loading} />
      <OnboardingProgressMeterSkeleton />
      {/* `role="list"`: `list-style: none` drops list semantics in Safari, and
          without them a screen reader stops announcing "2 of 3". */}
      <ol className={styles.list} role="list">
        {ONBOARDING_STEP_IDS.map((stepId, index) => (
          <OnboardingStepItemSkeleton
            key={stepId}
            stepId={stepId}
            position={index + 1}
            isOpen={index === 0}
          />
        ))}
      </ol>
    </Stack>
  );
}
