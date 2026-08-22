import type { ReactNode } from 'react';
import styles from './UsageMeter.module.css';

/**
 * A "how much of your allowance is gone" gauge. Usage:
 *
 * ```tsx
 * <UsageMeter heading="Agent seats" summary="4 of 5 seats in use" ratio={0.8} tone="warning">
 *   1 invitation is outstanding and counts against the cap.
 * </UsageMeter>
 * ```
 *
 * **The words carry the information; the bar repeats it.** `summary` states the
 * numbers in a sentence, which is what makes this correct in forced-colors mode
 * and for anyone who cannot distinguish the tones. Given `value` and `max` the
 * bar is additionally a real `progressbar` so an assistive technology can report
 * the proportion on request (TAR-711) — `role="meter"` was the alternative and
 * is still unevenly implemented. Without them it stays `aria-hidden` decoration,
 * which is what a skeleton wants: a placeholder must not announce a measurement.
 *
 * `ratio` is clamped by the rule that consumes it, so a count that has somehow
 * overshot its cap renders a full bar rather than one that escapes the track.
 * Omit it for an unlimited allowance — there is no proportion to draw.
 */

export const USAGE_METER_TONES = ['accent', 'warning', 'danger'] as const;
export type UsageMeterTone = (typeof USAGE_METER_TONES)[number];

export interface UsageMeterProps {
  heading: string;
  /**
   * The numbers, in words. This is the accessible content, and in every real
   * use it is a string.
   *
   * A node is accepted for exactly one caller: a skeleton, which passes a
   * `SkeletonForText` shimmer measured from the copy that will replace it. That
   * is what lets the loading state render through this component rather than
   * through a hand-drawn approximation of it, which is how a skeleton drifts.
   */
  summary: ReactNode;
  /** 0–1. Omitted for an unlimited allowance, which draws no bar. */
  ratio?: number;
  /**
   * The two counts `ratio` was derived from — what is consumed and the ceiling.
   * Supplying them turns the bar into a `progressbar`; both come off one
   * `UsageReading`, so the drawn proportion and the announced one cannot drift.
   */
  value?: number;
  max?: number;
  tone?: UsageMeterTone;
  /** An extra line below the bar — what is outstanding, or what to do next. */
  children?: ReactNode;
}

export function UsageMeter({
  heading,
  summary,
  ratio,
  value,
  max,
  tone = 'accent',
  children,
}: UsageMeterProps) {
  const isMeasured = value !== undefined && max !== undefined;

  return (
    <div className={styles.meter}>
      <p className={styles.heading}>{heading}</p>
      <p className={styles.summary}>{summary}</p>
      {ratio === undefined ? null : (
        <span
          className={styles.track}
          data-tone={tone}
          style={{ '--usage-ratio': ratio } as React.CSSProperties}
          {...(isMeasured
            ? {
                role: 'progressbar',
                // The visible summary beside it is the text equivalent, so no
                // `aria-valuetext`: an invisible duplicate of a sentence already
                // on screen is the same sentence read twice.
                'aria-label': heading,
                'aria-valuemin': 0,
                'aria-valuenow': value,
                'aria-valuemax': max,
              }
            : { 'aria-hidden': true })}
        >
          <span className={styles.fill} />
        </span>
      )}
      {children === undefined ? null : <p className={styles.note}>{children}</p>}
    </div>
  );
}
