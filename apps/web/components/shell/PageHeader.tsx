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
export const PAGE_TITLE_VARIANTS = ['name', 'identifier'] as const;
export type PageTitleVariant = (typeof PAGE_TITLE_VARIANTS)[number];

export function PageHeader({
  title,
  subtitle,
  action,
  titleVariant = 'name',
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  /**
   * `identifier` draws the heading monospaced, for a title that is a machine
   * key rather than a name — the operator console addresses tenants by slug
   * because no admin read returns a name. Everything else is a `name`.
   */
  titleVariant?: PageTitleVariant;
}) {
  return (
    <Cluster as="header" justify="between" align="start" gap="4" className={styles.header}>
      <div className={styles.headingGroup}>
        <h1
          className={styles.title}
          data-variant={titleVariant === 'name' ? undefined : titleVariant}
        >
          {title}
        </h1>
        {subtitle === undefined ? null : <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {action === undefined ? null : <div className={styles.action}>{action}</div>}
    </Cluster>
  );
}
