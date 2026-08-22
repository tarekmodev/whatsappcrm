import type { ReactNode } from 'react';
import type { IconName } from './Icon';
import { StateLayout } from './StateLayout';

/**
 * The shared empty state. Usage:
 * `<EmptyState icon="ticket" title={…} description={…} action={<Button …/>} />`.
 *
 * An empty region explains why it is empty and **names the next step**. An empty
 * state without an action is a dead end, so `action` is omitted only where there
 * genuinely is no next step to name — in which case `tone="quiet"` is usually
 * the honest spelling, because the region is instructional rather than empty.
 *
 * ## Zero results is not the same state as never had any
 *
 * A filter that matched nothing must say what was filtered and offer to widen
 * it; an account with no data at all must say so and offer to set it up. Sharing
 * one string between them is what makes a search look broken. Every caller that
 * can be filtered branches on it.
 *
 * The anatomy — no border, no slab, an icon in a disc, centred in the container's
 * full height — lives in `StateLayout`, which `ErrorState` shares.
 */

export interface EmptyStateProps {
  /** Decorative. The title carries the meaning; the icon is `aria-hidden`. */
  icon: IconName;
  title: string;
  /** Two lines at most. */
  description?: string;
  /** The next step, as a real `Button` or `TextLink` — never a styled div. */
  action?: ReactNode;
  secondaryAction?: ReactNode;
  /**
   * `quiet` drops the disc for a region that is instructional rather than empty
   * — the thread column before a conversation is picked. Nothing is wrong there,
   * and drawing it like a state the user has landed in overstates it.
   */
  tone?: 'neutral' | 'quiet';
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  tone = 'neutral',
}: EmptyStateProps) {
  return (
    <StateLayout
      icon={icon}
      title={title}
      description={description}
      action={action}
      secondaryAction={secondaryAction}
      tone={tone}
    />
  );
}
