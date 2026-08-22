import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import styles from './PlanBullets.module.css';

/**
 * One block of a plan card's contents, as a marked list. Usage:
 * `<PlanBullets items={[{ id: 'seats', label: '10 agent seats' }]} />`.
 *
 * Extracted because a plan card renders two of these — its allowances and what
 * it includes — and before TAR-711 they were two different shapes: the
 * allowances came out as bare lines, the features as marked ones, and a tier
 * with nothing extra to list substituted a sentence for the list altogether.
 * Three content types where the buyer is trying to compare five tiers row by
 * row.
 *
 * So there is one shape and one component. **A tier with less to say shows fewer
 * bullets, never a different kind of block** — which is only enforceable if
 * there is a single place that draws them.
 *
 * `label` is a node rather than a string for one caller: the card's skeleton,
 * which passes a shimmer measured from the copy that will replace it, and so
 * renders through this component instead of a hand-drawn approximation of it.
 */

export interface PlanBullet {
  readonly id: string;
  readonly label: ReactNode;
}

export function PlanBullets({
  items,
  labelledBy,
}: {
  items: readonly PlanBullet[];
  /** The block's own visible heading, so the list announces what it is a list of. */
  labelledBy?: string;
}) {
  return (
    // `role="list"`: `list-style: none` drops list semantics in Safari, and this
    // is a list a screen-reader user needs the length of to compare two tiers.
    <ul className={styles.list} role="list" aria-labelledby={labelledBy}>
      {items.map((item) => (
        <li key={item.id} className={styles.item}>
          {/* Decorative: the text beside it is the meaning, and a marker that
              also announced itself would say everything twice. */}
          <Icon name="checklist" size="sm" className={styles.marker} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
