import type { ReactNode } from 'react';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { SkeletonLine } from '@/components/ui/Skeleton';
import styles from './MetricCard.module.css';

/**
 * One figure from the dashboard. Usage:
 *
 * ```tsx
 * <MetricCard label="First response time" value="2h 14m" methodology="…" details={[…]} />
 * ```
 *
 * **One anatomy for every tile**, which is the whole point of this component:
 * label, then the figure, then at most three secondary figures. Before TAR-519
 * three of the five tiles were `label / number / three lines of prose` and two
 * were the same plus a detail list — so a row whose job is to be scanned had two
 * shapes in it, and a hundred pixels of dead space in three of them.
 *
 * The **figure is the hero**: `--font-size-metric`, a step above the largest
 * heading, in tabular numerals so a column of tiles aligns and a figure that
 * changes between ranges does not jitter.
 *
 * The **methodology moved into the label's popover**. It is real information —
 * "median, from the ticket opening to the first reply" is exactly what a
 * supervisor quoting this number needs — and it is not information that has to
 * occupy half the tile to be available.
 *
 * A `<dl>` rather than a styled `<div>`: the label and the figure are a
 * term/definition pair, which is what lets a screen reader read "First response
 * time, 2 hours 14 minutes" instead of two unrelated fragments.
 *
 * The card never formats anything. It is handed rendered values, so the one
 * duration formatter in the app stays in `presentation.ts` (ADR 0009 decision 7).
 */

export interface MetricCardDetail {
  readonly id: string;
  readonly label: string;
  readonly value: ReactNode;
}

export interface MetricCardProps {
  label: string;
  /** Already formatted — a count, a duration, or a placeholder while loading. */
  value: ReactNode;
  /**
   * How the figure is measured, behind the label's info affordance. Omitted on a
   * figure that measures itself: a count of tickets opened needs no method.
   * Requires `methodologyLabel`, which names the affordance.
   */
  methodology?: string;
  /** Names the info affordance — "How first response time is measured". */
  methodologyLabel?: string;
  /**
   * Secondary figures beside the headline one: the average, the p90 and the
   * sample size. Empty on a card whose figure is a plain count, and at most
   * three — a fourth is a second metric wearing a tile it does not own.
   */
  details?: readonly MetricCardDetail[];
}

export function MetricCard({
  label,
  value,
  methodology,
  methodologyLabel,
  details = [],
}: MetricCardProps) {
  return (
    <div className={styles.card}>
      <dl className={styles.headline}>
        <dt className={styles.label}>
          <span className={styles.labelText}>{label}</span>
          {methodology === undefined || methodologyLabel === undefined ? null : (
            <InfoPopover label={methodologyLabel}>{methodology}</InfoPopover>
          )}
        </dt>
        <dd className={styles.value}>{value}</dd>
      </dl>
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
 * The loading tile. It **is** `MetricCard` — same wrapper, same regions, same
 * spacing tokens — with a line where the figure will be, so the swap to real
 * figures cannot shift anything.
 *
 * Every string here is the **real** one: the label, its methodology, and the
 * detail terms all render from the content layer, so there is nothing about them
 * to wait for and a shimmer over copy already in the bundle would be slower and
 * emptier. Only the figures are unknown.
 */
export function MetricCardSkeleton({
  label,
  methodology,
  methodologyLabel,
  detailLabels = [],
}: {
  label: string;
  methodology?: string;
  methodologyLabel?: string;
  detailLabels?: readonly string[];
}) {
  return (
    <MetricCard
      label={label}
      methodology={methodology}
      methodologyLabel={methodologyLabel}
      // `1em` at the value's own font size, so the placeholder occupies exactly
      // the line the figure will.
      value={<SkeletonLine width="4ch" height="1em" />}
      details={detailLabels.map((detailLabel, index) => ({
        id: String(index),
        label: detailLabel,
        value: <SkeletonLine width="4ch" />,
      }))}
    />
  );
}
