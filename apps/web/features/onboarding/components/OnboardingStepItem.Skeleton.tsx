import type { OnboardingStepId } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { Badge } from '@/components/ui/Badge';
import { SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { ONBOARDING_STATUS_TONES } from '../presentation';
import styles from './OnboardingStepItem.module.css';

/**
 * Mirrors `OnboardingStepItem`, reusing its module CSS rather than approximating
 * it — same wrapper, same grid, same marker, same indentation — so the swap to
 * real content moves nothing.
 *
 * The copy is `SkeletonForText` over the real strings, because the checklist's
 * titles and descriptions are static: only each step's *status* is data. That
 * makes the placeholder wrap exactly where the real line will, which is the whole
 * difference between a skeleton that holds its height on a phone and one that
 * jumps by a line.
 *
 * Changed in the same commit as the component it stands in for.
 */
export function OnboardingStepItemSkeleton({
  stepId,
  position,
  isOpen,
}: {
  stepId: OnboardingStepId;
  position: number;
  isOpen: boolean;
}) {
  const copy = content.onboarding.steps[stepId];

  return (
    <li className={styles.item} aria-current={isOpen ? 'step' : undefined}>
      <div className={styles.header}>
        <span className={styles.marker} aria-hidden="true">
          {position}
        </span>
        <div className={styles.headingGroup}>
          <h3 className={styles.title}>
            {/* A closed step's real title is a link, and `.titleLink` gives it
                vertical padding. Without the same wrapper here the row loads
                taller than it was drawn. */}
            {isOpen ? (
              <span className={styles.titleMeasure}>
                <SkeletonForText>{copy.title}</SkeletonForText>
              </span>
            ) : (
              <span className={styles.titleLink}>
                <SkeletonForText>{copy.title}</SkeletonForText>
              </span>
            )}
          </h3>
          <p className={styles.summary}>
            <SkeletonForText>{copy.summary}</SkeletonForText>
          </p>
        </div>
        {/*
          A real `Badge`, so the padding, radius and height are the component's
          own rather than a guess. The word inside is the pending label: the
          status is the one thing the skeleton cannot know, and a checklist being
          loaded for the first time — which is what this stands in for — shows
          exactly that.
        */}
        <Badge tone={ONBOARDING_STATUS_TONES.pending}>
          <SkeletonForText>{content.onboarding.statuses.pending}</SkeletonForText>
        </Badge>
      </div>

      {isOpen ? (
        <Stack gap="3" className={styles.body}>
          <p className={styles.detail}>
            <SkeletonForText>{copy.detail}</SkeletonForText>
          </p>
          <Cluster gap="3">
            <SkeletonLine width="10rem" height="var(--size-touch-target)" />
            <SkeletonLine width="8rem" height="var(--size-touch-target)" />
          </Cluster>
        </Stack>
      ) : null}
    </li>
  );
}
