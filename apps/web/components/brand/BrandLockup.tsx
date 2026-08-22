import Link from 'next/link';
import type { TenantBranding } from '@whatsappcrm/contracts';
import { cx } from '@/lib/cx';
import { routes } from '@/lib/routes';
import { BrandLogo } from './BrandLogo';
import styles from './BrandLockup.module.css';

/**
 * The tenant's logo, or its name, linking home. Usage:
 * `<BrandLockup branding={branding} className={styles.brand} />`.
 *
 * The chrome's wordmark everywhere except the rail: the top bar carries it below
 * the layout breakpoint, and the drawer heads its navigation with it — the same
 * lockup in both, so white-labelling replaces one thing.
 *
 * The rail's is deliberately not this component. It carries a *second* spelling
 * — the initial that survives the collapsed width — and that pair belongs to the
 * rail's geometry rather than to the brand.
 */
export function BrandLockup({
  branding,
  className,
}: {
  branding: TenantBranding;
  className?: string;
}) {
  return (
    <Link
      href={routes.inbox()}
      className={cx(styles.lockup, className)}
      aria-label={branding.productName}
    >
      {branding.logo === null ? (
        <span className={styles.name}>{branding.productName}</span>
      ) : (
        <BrandLogo branding={branding} />
      )}
    </Link>
  );
}
