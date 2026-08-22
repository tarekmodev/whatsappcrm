import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { content } from '@/content/en';
import { formatDuration } from '@/features/reports/presentation';

/**
 * A duration statistic, or a quiet mark where there is none. Usage:
 * `<MeasuredDuration seconds={row.firstResponse.medianSeconds} />`.
 *
 * **Null is not zero**, and the contract is explicit about why: a range in which
 * nothing was answered and a range in which everything was answered instantly
 * are different facts. What changed in TAR-519 is how the first one *looks* —
 * "No data" repeated down two columns of a table and across three rows of a tile
 * is a wall of words where absence should be quiet, and it reads as six problems
 * rather than as six blanks.
 *
 * So absence is an em dash for the eye and the same sentence as before for a
 * screen reader. Nothing is lost: the mark is `aria-hidden`, the words are not,
 * and a keyboard or screen-reader user hears exactly what they used to.
 *
 * The headline figure on a metric tile keeps the words — there the absence *is*
 * the answer to the question the tile asks, and a dash as a hero says nothing.
 */
export function MeasuredDuration({ seconds }: { seconds: number | null }) {
  if (seconds === null) {
    return (
      <>
        <span aria-hidden="true">{content.reports.noMeasurementMark}</span>
        <VisuallyHidden>{content.reports.noMeasurement}</VisuallyHidden>
      </>
    );
  }

  return <>{formatDuration(seconds, content)}</>;
}
