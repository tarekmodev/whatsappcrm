import type { ReactNode } from 'react';
import styles from './Notice.module.css';

/**
 * An inline informational banner. Usage:
 * `<Notice tone="info">…</Notice>`.
 *
 * Not a toast: a toast is transient and for the result of an action, while this
 * explains something about the content that is on screen right now.
 */

export const NOTICE_TONES = ['info', 'warning'] as const;
export type NoticeTone = (typeof NOTICE_TONES)[number];

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: NoticeTone }) {
  return (
    <p className={styles.notice} data-tone={tone}>
      {children}
    </p>
  );
}
