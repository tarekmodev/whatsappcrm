import type { ReactNode } from 'react';
import { Cluster } from '@/components/layout/Cluster';
import { cx } from '@/lib/cx';
import styles from './SectionCard.module.css';

/**
 * The frame every page section sits in. Usage:
 * `<SectionCard title={…} headingLevel={2} action={<Button …/>}>…</SectionCard>`.
 *
 * Owning the frame here is what lets a section, its skeleton, its empty state and
 * its error state share one outline — which is why swapping between them produces
 * no layout shift.
 *
 * `isTitleVisible={false}` keeps the heading for the document outline and for the
 * region's accessible name, and takes it off the screen. For the one card on a
 * route whose title only restates the page's `<h1>` — the ticket queue's "Ticket
 * queue" under "Tickets" (TAR-520), and the contact directory's "Contacts" under
 * "Contacts" (TAR-727). It is not licence to hide a title because a card looks
 * busy: a card that is one of several on a page needs its name.
 */

export interface SectionCardProps {
  title: string;
  children: ReactNode;
  /**
   * The line under the title. A node rather than a string, so a section's
   * skeleton can put a `SkeletonLine` exactly where the real sentence goes —
   * without it the card is a line shorter while it loads, and everything below
   * jumps when the data lands.
   */
  description?: ReactNode;
  /** Kept explicit so a section can be nested without breaking heading order. */
  headingLevel?: 2 | 3;
  action?: ReactNode;
  /** Hides the heading from the eye only. See the note above before using it. */
  isTitleVisible?: boolean;
  /** Links the card's heading to a region label; also the scroll anchor. */
  id?: string;
}

export function SectionCard({
  title,
  children,
  description,
  headingLevel = 2,
  action,
  isTitleVisible = true,
  id,
}: SectionCardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const headingId = id === undefined ? undefined : `${id}-heading`;

  // The class rather than `VisuallyHidden`, whose wrapper is a `<span>` — a
  // heading inside one is not phrasing content.
  const heading = (
    <Heading
      id={headingId}
      // A card with an `id` is a card something links to, and a fragment link
      // scrolls a heading into view without moving focus to it — so a keyboard
      // reader lands at the top of the page they just left. `-1` keeps it out of
      // the tab order and makes `focus()` legal, which is what an in-page rail
      // needs to send somebody to the card they picked (TAR-813).
      tabIndex={headingId === undefined ? undefined : -1}
      className={cx(styles.heading, isTitleVisible ? undefined : styles.headingHidden)}
    >
      {title}
    </Heading>
  );

  // The whole header block goes with it, rather than a hidden heading leaving a
  // gap the card's own `gap` would still draw. A hidden title with a description
  // or an action beside it would be a header with no name, so this branch is
  // taken only when there is nothing else in the row.
  if (!isTitleVisible && description === undefined && action === undefined) {
    return (
      <section id={id} className={styles.card} aria-labelledby={headingId}>
        {heading}
        {children}
      </section>
    );
  }

  return (
    <section id={id} className={styles.card} aria-labelledby={headingId}>
      <Cluster justify="between" align="start" gap="3" className={styles.header}>
        <div className={styles.headingGroup}>
          {heading}
          {description === undefined ? null : <p className={styles.description}>{description}</p>}
        </div>
        {action === undefined ? null : <div className={styles.action}>{action}</div>}
      </Cluster>
      {children}
    </section>
  );
}
