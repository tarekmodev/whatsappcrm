import Link from 'next/link';
import { withBrandingDefaults } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { BrandLockup } from '@/components/brand/BrandLockup';
import { MobileMenu } from '@/components/shell/MobileMenu';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { adminEnv } from '~/lib/admin-env';
import { content } from '~/content/en';
import { routes } from '~/lib/routes';
import { ADMIN_NAV_ITEMS } from '~/features/shell/navigation';
import { ForgetCredentialButton } from './ForgetCredentialButton';
import styles from './AdminBar.module.css';

/**
 * The operator console's top bar. A server component; `MobileMenu` and the
 * forget control are the client islands inside it, and the drawer renders from
 * the same `NavItem[]` the rail does — one copy of the navigation at every width.
 *
 * ## What it carries, and what it deliberately does not (spec §2.1)
 *
 * The environment marker and the "Forget credential" control, and that is all.
 * There is **no theme toggle, no account menu and no search**: there is no
 * account, a search would have nothing to search, and 0001's rule holds that the
 * shell carries nothing for a feature the app does not have.
 *
 * ## The environment marker
 *
 * The one thing this console has that the tenant console does not, and it earns
 * its place: every write on this surface is cross-tenant and irreversible, and
 * "which environment am I in" is the question behind every operator incident.
 *
 * `danger` for production and `neutral` elsewhere — the tone is the glance, and
 * the word beside it is what a reader who cannot see the colour gets. The value
 * comes from the app's own build-time config and **never from an API**: a badge
 * fetched from the environment it describes is a badge that reads `Staging` when
 * the fetch fails.
 */
export function AdminBar() {
  const platform = withBrandingDefaults(null);
  const deployment = adminEnv.deployment;

  return (
    <header className={styles.bar}>
      <div className={styles.start}>
        <MobileMenu
          items={ADMIN_NAV_ITEMS}
          brand={
            <Link
              href={routes.tenants()}
              className={styles.drawerBrand}
              aria-label={content.app.name}
            >
              <BrandLockup branding={platform} />
            </Link>
          }
        />
        <Link href={routes.tenants()} className={styles.brand} aria-label={content.app.name}>
          <BrandLockup branding={platform} />
        </Link>
      </div>

      <div className={styles.end}>
        {/*
          The word alone would read as a stray noun in the bar, so the badge is
          named for assistive technology. The tone is decoration on top of the
          word, never instead of it — which is also what keeps it readable in
          forced-colors mode.
        */}
        <Badge tone={deployment === 'production' ? 'danger' : 'neutral'} size="md">
          <VisuallyHidden>{`${content.deployment.label}: `}</VisuallyHidden>
          {content.deployment.names[deployment]}
        </Badge>
        <ForgetCredentialButton />
      </div>
    </header>
  );
}
