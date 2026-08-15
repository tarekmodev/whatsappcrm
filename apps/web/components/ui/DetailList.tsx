import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './DetailList.module.css';

/**
 * Term-and-value pairs, as a real `<dl>`. Usage:
 *
 * ```tsx
 * <DetailList
 *   items={[
 *     { id: 'plan', term: 'Plan', value: 'Trial' },
 *     { id: 'trial-ends', term: 'Trial ends', value: <RelativeTime … /> },
 *   ]}
 * />
 * ```
 *
 * A `<dl>` rather than a two-column grid of `<span>`s because the pairing is the
 * meaning: a screen reader reads "Plan, Trial" as one unit, where two loose spans
 * are two unrelated strings. It is also why the term is never spliced into the
 * value's sentence — that shape cannot be translated and cannot be read out.
 *
 * Values may be nodes, which is what lets a deadline row carry a `RelativeTime`
 * instead of a date this component would have to format itself.
 */

export interface DetailListItem {
  readonly id: string;
  readonly term: string;
  readonly value: ReactNode;
  /**
   * A line under the value — why a value cannot be changed, or what it is for.
   * Inside the `<dd>` so it belongs to the pair a screen reader is reading,
   * rather than floating loose after it.
   */
  readonly hint?: string;
}

export function DetailList({
  items,
  className,
}: {
  items: readonly DetailListItem[];
  className?: string;
}) {
  return (
    <dl className={cx(styles.list, className)}>
      {items.map((item) => (
        <div key={item.id} className={styles.row}>
          <dt className={styles.term}>{item.term}</dt>
          <dd className={styles.value}>
            {item.value}
            {item.hint === undefined ? null : <span className={styles.hint}>{item.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
