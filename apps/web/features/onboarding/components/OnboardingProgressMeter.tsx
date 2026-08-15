import { content } from '@/content/en';
import { SkeletonLine } from '@/components/ui/Skeleton';
import styles from './OnboardingProgressMeter.module.css';

/**
 * How far through setup the tenant is. Usage:
 * `<OnboardingProgressMeter resolved={2} total={3} />`.
 *
 * A `progressbar` rather than a bare bar, with `aria-valuetext` carrying the same
 * sentence the visible count shows — "2 of 3 done" is what a person needs, and
 * "66" is what a raw `aria-valuenow` would say on its own.
 *
 * The fill is a fraction on a custom property because it is a per-instance
 * measurement; the rule that turns it into a width lives in the module file. That
 * is the one inline style this codebase allows.
 */
export function OnboardingProgressMeter({ resolved, total }: { resolved: number; total: number }) {
  const label = content.onboarding.progressCount(resolved, total);
  // `total` is fixed by the contract at three, so this can only be a divide-by-
  // zero if the checklist shape changes underneath us — in which case an empty
  // bar is the honest answer, not `NaN%`.
  const fraction = total === 0 ? 0 : resolved / total;

  return (
    <div className={styles.meter}>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={content.onboarding.progressLabel}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={resolved}
        aria-valuetext={label}
      >
        <span
          className={styles.fill}
          style={{ '--onboarding-progress': fraction } as React.CSSProperties}
        />
      </div>
      <p className={styles.count}>{label}</p>
    </div>
  );
}

/**
 * Mirrors the meter: same wrapper, same track height, same count line. The track
 * is drawn empty rather than shimmering — a bar that animates its own fill would
 * read as progress that is happening.
 */
export function OnboardingProgressMeterSkeleton() {
  return (
    <div className={styles.meter}>
      <div className={styles.track} aria-hidden="true" />
      <p className={styles.count}>
        {/* A content measurement, like every other placeholder width in this
            codebase: the count is data that has not arrived, so a width is the
            honest answer where `SkeletonForText` would need copy we do not have. */}
        <SkeletonLine width="6rem" />
      </p>
    </div>
  );
}
