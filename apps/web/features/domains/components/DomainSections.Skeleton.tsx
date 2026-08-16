import { Stack } from '@/components/layout/Stack';
import { Cluster } from '@/components/layout/Cluster';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonBlock, SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import cardStyles from './DomainCard.module.css';
import listStyles from './DomainList.module.css';
import styles from './DomainSections.module.css';

/**
 * Mirrors `DomainSections` — the same card, the same action row, the same list of
 * hostname cards — so the route's `loading.tsx` hands over without a reflow.
 *
 * It imports `DomainCard.module.css` and `DomainList.module.css` rather than
 * approximating their layout, so a change to either lands here in the same commit.
 *
 * **Two rows, always.** Every tenant has a platform subdomain, so a one-row
 * skeleton would under-reserve for the common case; more than two would be a
 * guess, and an over-tall skeleton collapses on arrival just as visibly as a
 * short one grows.
 */
export function DomainSectionsSkeleton() {
  const content = useContent();

  return (
    <Stack gap="5">
      <LoadingAnnouncement label={content.domains.loading} />
      <SectionCard
        title={content.domains.listHeading}
        description={content.domains.listDescription}
      >
        <Stack gap="4">
          <div className={listStyles.actions}>
            <span aria-hidden="true" className={styles.actionPlaceholder}>
              <SkeletonForText>{content.domains.addButton}</SkeletonForText>
            </span>
          </div>
          <ul className={listStyles.list}>
            <li>
              <SkeletonDomainCard />
            </li>
            <li>
              <SkeletonDomainCard />
            </li>
          </ul>
        </Stack>
      </SectionCard>
    </Stack>
  );
}

function SkeletonDomainCard() {
  const content = useContent();

  return (
    <div className={cardStyles.card}>
      <Stack gap="4">
        <Cluster justify="between" align="start" gap="3">
          <div className={cardStyles.identity}>
            <p className={cardStyles.hostname}>
              <SkeletonLine width="14rem" />
            </p>
            <p className={cardStyles.kind}>
              <SkeletonForText>{content.domains.kinds.custom}</SkeletonForText>
            </p>
          </div>
          <SkeletonLine width="6rem" />
        </Cluster>
        <p className={cardStyles.statusBody}>
          <SkeletonForText>
            {content.domains.statusDescriptions.pending_verification}
          </SkeletonForText>
        </p>
        {/* The DNS record block: three rows in a bordered box, same as the real
            one, because a pending domain always carries it. */}
        <SkeletonBlock height="calc(var(--space-8) + var(--space-5))" />
        <div className={cardStyles.actions}>
          <span aria-hidden="true" className={styles.actionPlaceholder}>
            <SkeletonForText>{content.domains.verifyButton}</SkeletonForText>
          </span>
        </div>
      </Stack>
    </div>
  );
}
