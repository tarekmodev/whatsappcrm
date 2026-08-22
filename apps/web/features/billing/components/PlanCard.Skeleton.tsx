import { Stack } from '@/components/layout/Stack';
import { SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { PlanBullets } from './PlanBullets';
import styles from './PlanCard.module.css';

/**
 * Mirrors `PlanCard` — the same card frame, the same four or five subgrid
 * regions, the same heading, price, two allowance bullets and feature bullets —
 * so the swap to real content changes no height.
 *
 * It reuses `PlanCard.module.css` and the card's own `PlanBullets` rather than
 * drawing its own boxes, which is what stops the two drifting: a padding, a
 * radius or a marker changed on the card is changed here by construction. The
 * group headings are the real strings, because they are copy this skeleton
 * already knows; only the values shimmer.
 *
 * Three feature rows is the honest guess rather than the largest: the tallest
 * tier carries eight, and reserving eight would leave the grid a screen taller
 * than the plans that replace it. A card that grows slightly on arrival is a
 * smaller error than a page that collapses.
 *
 * `aria-hidden`, with the single announcement made once by the section above —
 * a screen reader hearing "loading" five times is worse than not hearing it.
 *
 * Changed in the same commit as the card it stands in for.
 */
export function PlanCardSkeleton() {
  const content = useContent();

  return (
    <li className={styles.card} aria-hidden="true" data-has-action="true">
      <div className={styles.header}>
        <SkeletonLine width="7rem" height="var(--font-size-heading-sm)" />
      </div>

      <p className={styles.price}>
        <SkeletonLine width="6rem" className={styles.amountPlaceholder} />
        <SkeletonForText>{content.billing.seatCadence.month}</SkeletonForText>
      </p>

      <Stack gap="2">
        <h4 className={styles.groupHeading}>{content.billing.allowancesHeading}</h4>
        <PlanBullets
          items={[
            {
              id: 'seats',
              label: <SkeletonForText>{content.billing.allowanceSeats('00')}</SkeletonForText>,
            },
            {
              id: 'conversations',
              label: (
                <SkeletonForText>{content.billing.allowanceConversations('0,000')}</SkeletonForText>
              ),
            },
          ]}
        />
      </Stack>

      <Stack gap="2">
        <h4 className={styles.groupHeading}>{content.billing.featuresHeading}</h4>
        <PlanBullets
          items={SKELETON_FEATURES.map((feature) => ({
            id: feature,
            label: <SkeletonForText>{content.billing.features[feature]}</SkeletonForText>,
          }))}
        />
      </Stack>

      <div className={styles.action}>
        <SkeletonLine width="100%" height="var(--size-control-md)" />
      </div>
    </li>
  );
}

/** Three of the catalogue's own lines, so the placeholders wrap as the real ones will. */
const SKELETON_FEATURES = ['assignment_rules', 'sla_policies', 'workflows'] as const;
