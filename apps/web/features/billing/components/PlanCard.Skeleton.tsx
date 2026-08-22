import { Stack } from '@/components/layout/Stack';
import { SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import styles from './PlanCard.module.css';

/**
 * Mirrors `PlanCard` — the same card frame, the same stack and gap, the same
 * heading, price, two allowance lines and feature list — so the swap to real
 * content changes no height.
 *
 * It reuses `PlanCard.module.css` rather than drawing its own boxes, which is
 * what stops the two drifting: a padding or radius changed on the card is
 * changed here by construction. The group headings are the real strings, because
 * they are copy this skeleton already knows; only the values shimmer.
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
    <article className={styles.card} aria-hidden="true">
      <Stack gap="4" className={styles.body}>
        <div className={styles.header}>
          <SkeletonLine width="7rem" height="var(--font-size-heading-sm)" />
        </div>

        <p className={styles.price}>
          <SkeletonLine width="5rem" height="var(--font-size-heading-md)" />
        </p>

        <Stack gap="2">
          <h4 className={styles.groupHeading}>{content.billing.allowancesHeading}</h4>
          <div className={styles.list}>
            <SkeletonForText>{content.billing.allowanceSeats('00')}</SkeletonForText>
            <SkeletonForText>{content.billing.allowanceConversations('0,000')}</SkeletonForText>
          </div>
        </Stack>

        <Stack gap="2">
          <h4 className={styles.groupHeading}>{content.billing.featuresHeading}</h4>
          <div className={styles.list}>
            <SkeletonForText>{content.billing.features.assignment_rules}</SkeletonForText>
            <SkeletonForText>{content.billing.features.sla_policies}</SkeletonForText>
            <SkeletonForText>{content.billing.features.workflows}</SkeletonForText>
          </div>
        </Stack>

        <div className={styles.action}>
          <SkeletonLine width="100%" height="var(--size-control-md)" />
        </div>
      </Stack>
    </article>
  );
}
