import { SkeletonLine } from '@/components/ui/Skeleton';
import styles from './MetricCard.module.css';

/**
 * One figure from the dashboard, with what it is measured over. Usage:
 *
 * ```tsx
 * <MetricCard label="First response time" value="2h 14m" hint="…" details={[…]} />
 * ```
 *
 * A `<dl>` rather than a styled `<div>`: the label and the figure are a
 * term/definition pair, which is what lets a screen reader read "First response
 * time, 2 hours 14 minutes" instead of two unrelated fragments.
 *
 * The card never formats anything. It is handed strings, so the one duration
 * formatter in the app stays in `presentation.ts` (ADR 0009 decision 7).
 */

export interface MetricCardDetail {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface MetricCardProps {
  label: string;
  /** Already formatted — a count, a duration, or the "No data" word. */
  value: string;
  /** What the figure is measured over. Shown, not hidden behind a tooltip. */
  hint: string;
  /**
   * Secondary statistics beside the headline one: the average, the p90 and the
   * sample size. Empty on a card whose figure is a plain count.
   */
  details?: readonly MetricCardDetail[];
}

export function MetricCard({ label, value, hint, details = [] }: MetricCardProps) {
  return (
    <div className={styles.card}>
      <dl className={styles.headline}>
        <dt className={styles.label}>{label}</dt>
        <dd className={styles.value}>{value}</dd>
      </dl>
      <p className={styles.hint}>{hint}</p>
      {details.length === 0 ? null : (
        <dl className={styles.details}>
          {details.map((detail) => (
            <div key={detail.id} className={styles.detail}>
              <dt className={styles.detailLabel}>{detail.label}</dt>
              <dd className={styles.detailValue}>{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * Mirrors `MetricCard` exactly — the same wrapper, the same three regions, the
 * same spacing tokens — so the swap to real figures shifts nothing.
 *
 * The label and the hint are the **real** strings, not placeholders: both render
 * from constants, so there is nothing about them to wait for, and drawing a
 * shimmer over copy already known would be slower and emptier. Only the figures
 * are unknown, and only they are drawn as lines.
 */
export function MetricCardSkeleton({
  label,
  hint,
  detailCount = 0,
}: {
  label: string;
  hint: string;
  detailCount?: number;
}) {
  return (
    <div className={styles.card}>
      <dl className={styles.headline}>
        <dt className={styles.label}>{label}</dt>
        <dd className={styles.value}>
          <SkeletonLine width="5ch" height="1em" />
        </dd>
      </dl>
      <p className={styles.hint}>{hint}</p>
      {detailCount === 0 ? null : (
        <dl className={styles.details}>
          {Array.from({ length: detailCount }, (_unused, index) => (
            <div key={index} className={styles.detail}>
              <dt className={styles.detailLabel}>
                <SkeletonLine width="6ch" />
              </dt>
              <dd className={styles.detailValue}>
                <SkeletonLine width="4ch" />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
