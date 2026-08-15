import Link from 'next/link';
import type { OnboardingStep } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { Badge } from '@/components/ui/Badge';
import { Notice } from '@/components/ui/Notice';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import {
  ONBOARDING_STATUS_TONES,
  ONBOARDING_STEP_DESTINATIONS,
  onboardingStepIntent,
} from '../presentation';
import { OnboardingStepIntentButton } from './OnboardingStepIntentButton';
import styles from './OnboardingStepItem.module.css';

/**
 * One row of the checklist. Usage:
 * `<OnboardingStepItem step={step} position={1} isOpen />` — inside the `<ol>`
 * that `OnboardingChecklist` owns.
 *
 * A server component: the only interactive part is the skip control, which is its
 * own client island. Which row is open comes from the URL, so opening one is a
 * navigation rather than a state change — that is what makes "carry on where I
 * left off" a link somebody can share and the back button can undo.
 *
 * The closed row's heading is a link to this step; the open row's is a plain
 * heading, because a link to the page you are already looking at is a control
 * that does nothing.
 */
export function OnboardingStepItem({
  step,
  position,
  isOpen,
}: {
  step: OnboardingStep;
  /** 1-based, shown in the marker. The `<ol>` is what announces it to a screen reader. */
  position: number;
  isOpen: boolean;
}) {
  const copy = content.onboarding.steps[step.id];
  const destination = ONBOARDING_STEP_DESTINATIONS[step.id];
  const intent = onboardingStepIntent(step.status);

  return (
    <li
      className={styles.item}
      data-status={step.status}
      aria-current={isOpen ? 'step' : undefined}
    >
      <div className={styles.header}>
        <span className={styles.marker} aria-hidden="true">
          {position}
        </span>
        <div className={styles.headingGroup}>
          <h3 className={styles.title}>
            {isOpen ? (
              copy.title
            ) : (
              <Link className={styles.titleLink} href={routes.onboarding({ stepId: step.id })}>
                {copy.title}
              </Link>
            )}
          </h3>
          <p className={styles.summary}>{copy.summary}</p>
        </div>
        {/* The status is always words as well as colour, so it survives forced
            colours and reads the same to somebody who cannot see the tone. */}
        <Badge tone={ONBOARDING_STATUS_TONES[step.status]}>
          {content.onboarding.statuses[step.status]}
        </Badge>
      </div>

      {isOpen ? (
        <Stack gap="3" className={styles.body}>
          <p className={styles.detail}>{copy.detail}</p>
          {destination === null ? (
            <Notice tone="info">{content.onboarding.unavailableNotice}</Notice>
          ) : null}
          <Cluster gap="3">
            {destination === null ? null : (
              <Link className={styles.action} href={destination}>
                {copy.action}
              </Link>
            )}
            {intent === null ? null : (
              <OnboardingStepIntentButton stepId={step.id} intent={intent} stepTitle={copy.title} />
            )}
          </Cluster>
        </Stack>
      ) : null}
    </li>
  );
}
