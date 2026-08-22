import { cx } from '@/lib/cx';
import styles from './Avatar.module.css';

/**
 * The initial of a name, in a circle. Usage: `<Avatar name={displayName} />`, or
 * `<Avatar name={contact.displayName} size="md" tone="neutral" />`.
 *
 * Decorative by construction — `aria-hidden`, no accessible name of its own. The
 * name it stands for is always beside it in text, and an avatar that announced
 * itself would say it twice.
 *
 * There is no image variant. Neither the session contract nor `ContactResponse`
 * carries an avatar URL, and a component with a `src` nothing can fill is a
 * promise the data layer cannot keep.
 */

/**
 * `xs` is the mark inside a dense row — the assignee on a conversation row,
 * where the circle is metadata beside a timestamp rather than the row's own
 * identity. `sm` is that identity (the contact leading a row), `md` a detail
 * header. Anything smaller than `xs` loses the initial, which is the only thing
 * an avatar with no image has to say.
 */
export const AVATAR_SIZES = ['xs', 'sm', 'md'] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];

export const AVATAR_TONES = ['accent', 'neutral'] as const;
export type AvatarTone = (typeof AVATAR_TONES)[number];

export interface AvatarProps {
  /** The name to take an initial from. An empty name renders an empty circle. */
  name: string;
  size?: AvatarSize;
  tone?: AvatarTone;
  className?: string;
}

export function Avatar({ name, size = 'sm', tone = 'accent', className }: AvatarProps) {
  return (
    <span
      className={cx(styles.avatar, className)}
      data-size={size}
      data-tone={tone}
      aria-hidden="true"
    >
      {initialOf(name)}
    </span>
  );
}

/**
 * Spread rather than `charAt`, so a name starting outside the basic multilingual
 * plane — an emoji, or most of the CJK extensions — does not lose half its first
 * character to a lone surrogate.
 */
function initialOf(name: string): string {
  return [...name.trim()][0] ?? '';
}
