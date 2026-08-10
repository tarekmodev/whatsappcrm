import type { ReactNode } from 'react';
import { Cluster } from '@/components/layout/Cluster';
import styles from './PageHeader.module.css';

/**
 * The `<h1>` region every route opens with. Usage:
 * `<PageHeader title={…} subtitle={…} action={…} />`.
 *
 * One per page, so heading order is correct by construction and no route
 * hand-rolls its title block.
 */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <Cluster as="header" justify="between" align="start" gap="4" className={styles.header}>
      <div className={styles.headingGroup}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle === undefined ? null : <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {action === undefined ? null : <div className={styles.action}>{action}</div>}
    </Cluster>
  );
}
