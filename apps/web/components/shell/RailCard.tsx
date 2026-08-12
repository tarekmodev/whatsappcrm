import type { ReactNode } from 'react';
import styles from './RailCard.module.css';

/**
 * The card that sits at the foot of the navigation rail. Usage:
 * `<AppSidebar items={…} footer={<RailCard title="…" body="…" action={<…/>} />} />`.
 *
 * A slot, not a message. Nothing in this product has anything to say here yet —
 * there is no trial, no upsell and no plan — so `app/(app)/layout.tsx` passes no
 * footer and the rail renders none. What this exists for is the shape: a
 * persistent card pinned below the navigation, with its own headline, one line of
 * copy, one primary action and any number of quieter links after it. When a story
 * does have something to put there (an onboarding checklist, a connection warning
 * while no WhatsApp number is linked), it composes this rather than inventing a
 * second card in the rail.
 *
 * Hidden with the rail below the layout breakpoint. The drawer is the navigation
 * there, and a promotional card is not navigation.
 */
export interface RailCardProps {
  title: string;
  body: string;
  /** The one primary control. Everything quieter goes in `links`. */
  action?: ReactNode;
  links?: ReactNode;
}

export function RailCard({ title, body, action, links }: RailCardProps) {
  return (
    <div className={styles.card}>
      <p className={styles.title}>{title}</p>
      <p className={styles.body}>{body}</p>
      {action === undefined ? null : <div className={styles.action}>{action}</div>}
      {links === undefined ? null : <div className={styles.links}>{links}</div>}
    </div>
  );
}
