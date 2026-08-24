import type { ReactNode } from 'react';
import styles from './Notice.module.css';

/**
 * An inline informational banner. Usage:
 * `<Notice tone="info">…</Notice>`, or `<Notice tone="info" variant="quiet">…</Notice>`.
 *
 * Not a toast: a toast is transient and for the result of an action, while this
 * explains something about the content that is on screen right now.
 */

/**
 * `danger` is the one a form's failure summary is drawn in (`FormError`), and it
 * is here rather than in that component so a screen cannot end up with two
 * different-looking ways of saying the same thing.
 */
/**
 * `success` is the newest of the four and the one worth justifying: a `Notice`
 * is *content that stays*, and a toast is an announcement that leaves — so the
 * success tone is for an outcome the reader has to keep reading, not for
 * confirming a save. The operator console's webhook replay is the case that
 * earned it (0002 spec §2.9): the result has to sit above a running log while
 * somebody works through a batch of ids, and a toast would be gone by the second.
 */
export const NOTICE_TONES = ['info', 'success', 'warning', 'danger'] as const;
export type NoticeTone = (typeof NOTICE_TONES)[number];

/**
 * How loudly it says it.
 *
 * `filled` is the default and is right for a notice that changes what the reader
 * can do — the service window having closed, a plan limit reached.
 *
 * `quiet` is for **guidance**: true, worth saying, and not an error. It keeps the
 * tone's text colour and drops the tint and the border, so it reads as a line of
 * copy rather than as a banner. TAR-518 is the case it exists for: the thread
 * carried two full-width saturated blocks, one above the message stream and one
 * in the composer, saying overlapping things about the same state — and a
 * saturated fill repeated like that out-shouts the button that answers it.
 */
export const NOTICE_VARIANTS = ['filled', 'quiet'] as const;
export type NoticeVariant = (typeof NOTICE_VARIANTS)[number];

export function Notice({
  children,
  tone = 'info',
  variant = 'filled',
}: {
  children: ReactNode;
  tone?: NoticeTone;
  variant?: NoticeVariant;
}) {
  return (
    <p className={styles.notice} data-tone={tone} data-variant={variant}>
      {children}
    </p>
  );
}
