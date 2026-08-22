import type { UsageMeterTone } from '@/components/ui/UsageMeter';

/**
 * Turns a count and a plan ceiling into what a meter renders.
 *
 * Extracted from `features/workspace/plan-usage.ts` when the billing surface
 * needed the identical rules (TAR-37). It lives in `lib/` rather than in either
 * feature for the reason the original file already gave for being separate from
 * its components: two surfaces that showed the same limit and disagreed about
 * whether it had been reached would be worse than one that showed it nowhere.
 *
 * Three rules a reader cannot infer from the shape:
 *
 *   1. **`null` is unlimited**, per `PlanLimitsSchema` — deliberately not `-1`,
 *      and deliberately not treated as zero, which would render every unlimited
 *      plan as permanently over its cap.
 *   2. **A count may exceed its cap.** A plan downgraded below current usage is
 *      a real state, so `ratio` is not clamped here — `UsageMeter` clamps what
 *      it draws, and `isAtCap` stays true rather than flipping to false above
 *      the line.
 *   3. **The warning tone is below the cap on purpose.** The point of a gauge is
 *      to be seen *before* the next invitation is refused.
 */

export interface UsageReading {
  /** What is consumed, including anything reserved but not yet taken up. */
  readonly used: number;
  /** `null` when the plan sets no limit. */
  readonly cap: number | null;
  /** Fraction consumed, or `undefined` when there is no cap to be a fraction of. */
  readonly ratio: number | undefined;
  readonly isAtCap: boolean;
  readonly tone: UsageMeterTone;
}

/** Where a meter changes colour, and where the volume warning is raised. */
export const USAGE_WARNING_RATIO = 0.8;

export function readUsage(used: number, cap: number | null): UsageReading {
  if (cap === null) {
    return { used, cap: null, ratio: undefined, isAtCap: false, tone: 'accent' };
  }

  // A cap of zero would divide by zero, and it means "none of this is
  // available" rather than "unlimited": full bar, at cap.
  const ratio = cap === 0 ? 1 : used / cap;

  return { used, cap, ratio, isAtCap: used >= cap, tone: toneFor(ratio) };
}

/**
 * Whether a reading has crossed the warning line, the cap, or neither.
 *
 * A three-state union rather than two booleans, because "approaching" and
 * "reached" are different messages with different urgency and the pair
 * `{ isApproaching: true, isAtCap: true }` is a state that means nothing.
 */
export type UsageThreshold = 'under' | 'approaching' | 'reached';

export function readThreshold(reading: UsageReading): UsageThreshold {
  if (reading.ratio === undefined) {
    return 'under';
  }

  if (reading.isAtCap) {
    return 'reached';
  }

  return reading.ratio >= USAGE_WARNING_RATIO ? 'approaching' : 'under';
}

function toneFor(ratio: number): UsageMeterTone {
  if (ratio >= 1) {
    return 'danger';
  }

  return ratio >= USAGE_WARNING_RATIO ? 'warning' : 'accent';
}
