import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Badge.module.css';

/**
 * Compact status label. Usage: `<Badge tone="success">Active</Badge>`, or
 * `<Badge variant="count" tone="info">{unread}</Badge>`.
 *
 * `tone` is intent, not colour, so a theme swap or a forced-colors mode does not
 * need the call site to change. The label always carries the meaning in text —
 * colour alone never conveys state.
 *
 * ## Variants
 *
 * | Variant   | Use                                          | Treatment                                                       |
 * | --------- | -------------------------------------------- | --------------------------------------------------------------- |
 * | `subtle`  | Status in a row, a cell, a header (default)   | The tone's `*-subtle` tint, `on-*-subtle` text, pill             |
 * | `outline` | Low-emphasis metadata — a channel, a team    | Transparent, hairline border, muted text; ignores `tone`         |
 * | `count`   | Unread counts, filter counts                 | Pill, tabular numerals, one width for `1` and `99`               |
 * | `dot`     | Presence of unread, with no number to give   | A circle in the tone's colour, no text                           |
 * | `quiet`   | A mark that lost a row's chip budget         | No pill, no tint, muted text; keeps the word, drops the emphasis |
 *
 * Two sizes: `sm` for a row or a table cell, `md` for a detail header. There is
 * no third — a chip that needs to be bigger than `md` is not a chip.
 *
 * ## The `dot` variant has no accessible name
 *
 * It renders a decorative circle and nothing else, so **the parent must name
 * it** — `aria-label` on the control it marks, or text beside it. A dot on its
 * own conveys state by colour alone, which 0001 forbids; the API cannot enforce
 * that, so it is stated here and the type refuses children to make the omission
 * visible rather than silently rendering hidden text.
 *
 * ## How many may appear
 *
 * 0001's "Status vocabulary": a list row shows at most **one** status chip and a
 * detail header at most **two**; a status the active filter already implies is
 * not shown; assignment is an avatar, never a text pill; and a count is the
 * `count` variant rather than a sentence in a pill.
 *
 * `quiet` is what a caller over that budget renders **instead of dropping the
 * label** (TAR-520). A conversation row can simply omit a chip it did not pick;
 * a *table* cannot, because the column header stays — and below 40rem
 * `DataTable` repeats it beside the value, so an empty cell reads as missing
 * data. The losing mark keeps its word and gives up its pill. It ignores `tone`
 * for the same reason `outline` does: not competing is the whole point.
 */

export const BADGE_TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'] as const;
export type BadgeTone = (typeof BADGE_TONES)[number];

export const BADGE_SIZES = ['sm', 'md'] as const;
export type BadgeSize = (typeof BADGE_SIZES)[number];

export const BADGE_VARIANTS = ['subtle', 'outline', 'count', 'quiet', 'dot'] as const;
export type BadgeVariant = (typeof BADGE_VARIANTS)[number];

interface BadgeBaseProps {
  tone?: BadgeTone;
  size?: BadgeSize;
  className?: string;
}

/**
 * A discriminated union rather than an optional `children`, so "a dot with a
 * label" — which would render the label nowhere — cannot be written.
 */
export type BadgeProps = BadgeBaseProps &
  (
    | { variant?: Exclude<BadgeVariant, 'dot'>; children: ReactNode }
    | { variant: 'dot'; children?: never }
  );

export function Badge({ tone = 'neutral', size = 'sm', className, ...rest }: BadgeProps) {
  if (rest.variant === 'dot') {
    return (
      <span
        className={cx(styles.badge, className)}
        data-variant="dot"
        data-tone={tone}
        data-size={size}
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      className={cx(styles.badge, className)}
      data-variant={rest.variant ?? 'subtle'}
      data-tone={tone}
      data-size={size}
    >
      {rest.children}
    </span>
  );
}
