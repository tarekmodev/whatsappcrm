import Link from 'next/link';
import type { TenantBranding } from '@whatsappcrm/contracts';
import { cx } from '@/lib/cx';
import { routes } from '@/lib/routes';
import { BrandLogo } from './BrandLogo';
import styles from './BrandLockup.module.css';

/**
 * The tenant's logo, or its name. Usage:
 * `<BrandLockup branding={branding} className={styles.brand} />`, or
 * `<BrandLockup branding={branding} size="lg" isLinked={false} />` above a
 * sign-in form.
 *
 * The chrome's wordmark everywhere except the rail: the top bar carries it below
 * the layout breakpoint, the drawer heads its navigation with it, and the
 * signed-out screens stand it above the form — the same lockup in all three, so
 * white-labelling replaces one thing.
 *
 * The rail's is deliberately not this component. It carries a *second* spelling
 * — the initial that survives the collapsed width — and that pair belongs to the
 * rail's geometry rather than to the brand.
 */
export function BrandLockup({
  branding,
  size = 'md',
  isLinked = true,
  className,
}: {
  branding: TenantBranding;
  /** `lg` on the signed-out screens, where the lockup is the only chrome. */
  size?: 'md' | 'lg';
  /**
   * `false` where there is nowhere to go: a signed-out visitor sent to the inbox
   * is a visitor sent back to the screen they are already on. It also decides
   * what names the product — the link's `aria-label` when there is a link, and
   * the wordmark itself (or the logo's `alt`) when there is not.
   */
  isLinked?: boolean;
  className?: string;
}) {
  const mark =
    branding.logo === null ? (
      <span className={styles.name}>{branding.productName}</span>
    ) : (
      <BrandLogo branding={branding} size={size} isDecorative={isLinked} />
    );

  if (!isLinked) {
    return (
      <span className={cx(styles.lockup, className)} data-size={size}>
        {mark}
      </span>
    );
  }

  return (
    <Link
      href={routes.inbox()}
      className={cx(styles.lockup, className)}
      data-size={size}
      aria-label={branding.productName}
    >
      {mark}
    </Link>
  );
}
