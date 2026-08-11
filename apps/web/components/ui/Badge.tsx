import type { ReactNode } from 'react';
import styles from './Badge.module.css';

/**
 * Compact status label. Usage: `<Badge tone="success">Active</Badge>`.
 *
 * `tone` is intent, not colour, so a theme swap or a forced-colors mode does not
 * need the call site to change. The label always carries the meaning in text —
 * colour alone never conveys state.
 */

export const BADGE_TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'] as const;
export type BadgeTone = (typeof BADGE_TONES)[number];

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {children}
    </span>
  );
}
