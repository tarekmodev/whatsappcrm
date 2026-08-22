import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import styles from './StateLayout.module.css';

/**
 * The anatomy every empty, forbidden and error state is drawn with (TAR-515).
 * Not used directly by a screen — `EmptyState` and `ErrorState` are the two
 * public spellings of it, and they exist so a caller cannot pick the wrong tone
 * for the wrong situation.
 *
 * It is one component rather than two near-identical ones because the *only*
 * difference between "there is nothing here" and "we could not load it" is the
 * tone of the icon and whether the announcement is polite or assertive. Two
 * copies of this layout would have drifted apart by the second screen.
 *
 * ## What it is not
 *
 * There is no border, no dashed outline and no sunken slab. A dashed box is a
 * wireframe artifact: it says "a component belongs here and has not been built",
 * which is precisely the wrong thing for the first screen a new workspace sees.
 * The state sits directly on its container's surface and is centred in the full
 * height that container gives it, and the icon plate carries the visual weight
 * the border used to.
 */

export const STATE_TONES = ['neutral', 'danger', 'quiet'] as const;
export type StateTone = (typeof STATE_TONES)[number];

export interface StateLayoutProps {
  /** Decorative — `Icon` is `aria-hidden` by construction; the title carries the meaning. */
  icon: IconName;
  title: string;
  /** Two lines at most. Longer than that is documentation, not a state. */
  description?: string;
  tone?: StateTone;
  /** The next step, as a real `Button` or `TextLink`. */
  action?: ReactNode;
  secondaryAction?: ReactNode;
  /** A quiet line below the copy — an error's correlation id, and nothing else. */
  note?: string;
  /**
   * `status` announces politely and is right for anything the user can act on;
   * `alert` interrupts and is for a state that blocks them. Omitted for an empty
   * state, which is the page's ordinary content rather than an event.
   */
  role?: 'status' | 'alert';
}

export function StateLayout({
  icon,
  title,
  description,
  tone = 'neutral',
  action,
  secondaryAction,
  note,
  role,
}: StateLayoutProps) {
  const hasActions = action !== undefined || secondaryAction !== undefined;

  return (
    <div className={styles.state} data-tone={tone} role={role}>
      <span className={styles.plate}>
        <Icon name={icon} size="lg" />
      </span>
      <p className={styles.title}>{title}</p>
      {description === undefined ? null : <p className={styles.description}>{description}</p>}
      {note === undefined ? null : <p className={styles.note}>{note}</p>}
      {hasActions ? (
        <div className={styles.actions}>
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
