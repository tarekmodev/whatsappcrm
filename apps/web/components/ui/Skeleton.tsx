import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Skeleton.module.css';

/**
 * The placeholder primitives every `*.Skeleton` component is built from. Usage:
 * `<SkeletonText lines={2} />`, `<SkeletonLine width="8rem" />`,
 * `<SkeletonCircle size="var(--size-control-md)" />`.
 *
 * Skeletons are `aria-hidden`: the region announces itself once through a polite
 * live region (see `LoadingAnnouncement`) instead of reading out a wall of
 * placeholder nodes.
 *
 * Sizes are passed as custom properties because they are per-instance content
 * measurements; the rules that consume them live in the module file.
 */

export interface SkeletonLineProps {
  /** Any CSS length. Defaults to filling the parent. */
  width?: string;
  height?: string;
  className?: string;
}

export function SkeletonLine({ width = '100%', height, className }: SkeletonLineProps) {
  return (
    <span
      aria-hidden="true"
      className={cx(styles.shimmer, styles.line, className)}
      style={
        {
          '--skeleton-width': width,
          ...(height === undefined ? {} : { '--skeleton-height': height }),
        } as React.CSSProperties
      }
    />
  );
}

export function SkeletonCircle({ size = 'var(--size-control-md)' }: { size?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(styles.shimmer, styles.circle)}
      style={{ '--skeleton-width': size, '--skeleton-height': size } as React.CSSProperties}
    />
  );
}

export function SkeletonBlock({ height = 'var(--space-8)', className }: SkeletonLineProps) {
  return (
    <span
      aria-hidden="true"
      className={cx(styles.shimmer, styles.block, className)}
      style={{ '--skeleton-height': height } as React.CSSProperties}
    />
  );
}

/**
 * A placeholder shaped by the copy it stands in for. Usage:
 * `<SkeletonForText>{content.auth.passwordHint(12)}</SkeletonForText>`.
 *
 * The other primitives take a width, which means a guess: a hint that wraps to
 * two lines on a phone and one on a laptop makes a fixed-height placeholder wrong
 * at one width or the other, and the card jumps by a line when the real content
 * arrives. This renders the real string invisibly — so it wraps exactly as it
 * will — and paints the shimmer over the box it occupies.
 *
 * Only for copy the skeleton actually knows. Where the text is data that has not
 * arrived yet, a `SkeletonLine` is the honest answer.
 */
export function SkeletonForText({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className={styles.forText}>
      <span className={cx(styles.shimmer, styles.forTextFill)} />
      {/* `visibility`, not `display`: it must still take up its space. */}
      <span className={styles.forTextMeasure}>{children}</span>
    </span>
  );
}

/**
 * A paragraph of placeholder lines. The final line is short, which is what makes
 * a text skeleton read as text rather than as a bar chart.
 */
export function SkeletonText({ lines = 2 }: { lines?: number }) {
  return (
    <span aria-hidden="true" className={styles.text}>
      {Array.from({ length: lines }, (_unused, index) => (
        <SkeletonLine key={index} width={index === lines - 1 ? '60%' : '100%'} />
      ))}
    </span>
  );
}
