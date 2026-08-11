import type { ReactNode } from 'react';
import { Cluster } from '@/components/layout/Cluster';
import styles from './SectionCard.module.css';

/**
 * The frame every page section sits in. Usage:
 * `<SectionCard title={…} headingLevel={2} action={<Button …/>}>…</SectionCard>`.
 *
 * Owning the frame here is what lets a section, its skeleton, its empty state and
 * its error state share one outline — which is why swapping between them produces
 * no layout shift.
 */

export interface SectionCardProps {
  title: string;
  children: ReactNode;
  description?: string;
  /** Kept explicit so a section can be nested without breaking heading order. */
  headingLevel?: 2 | 3;
  action?: ReactNode;
  /** Links the card's heading to a region label; also the scroll anchor. */
  id?: string;
}

export function SectionCard({
  title,
  children,
  description,
  headingLevel = 2,
  action,
  id,
}: SectionCardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const headingId = id === undefined ? undefined : `${id}-heading`;

  return (
    <section id={id} className={styles.card} aria-labelledby={headingId}>
      <Cluster justify="between" align="start" gap="3" className={styles.header}>
        <div className={styles.headingGroup}>
          <Heading id={headingId} className={styles.heading}>
            {title}
          </Heading>
          {description === undefined ? null : <p className={styles.description}>{description}</p>}
        </div>
        {action === undefined ? null : <div className={styles.action}>{action}</div>}
      </Cluster>
      {children}
    </section>
  );
}
