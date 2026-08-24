import Link from 'next/link';
import { withBrandingDefaults } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { BrandLockup } from '@/components/brand/BrandLockup';
import { LocaleToggle } from '@/components/locale/LocaleToggle';
import { MobileMenu } from '@/components/shell/MobileMenu';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { webEnv } from '@/lib/config/env';
import { readLocale } from '@/lib/locale/read-locale';
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
 * The environment marker, the language toggle and the "Forget credential"
 * control, and that is all. There is still **no theme toggle, no account menu
 * and no search**: there is no account, a search would have nothing to search,
 * and 0001's rule holds that the shell carries nothing for a feature the app
 * does not have.
 *
 * The language toggle is the one addition to that list (TAR-806), and it is not
 * an exception to the rule — reading direction *is* a feature this app has, from
 * the moment the root layout resolves `lang`/`dir` per request. Without a control
 * an operator could not reach it in a deployment, where this console is its own
 * host and the tenant console's cookie is never sent here. Behind the same flag
 * as the tenant console's, so the two switch on together.
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
export async function AdminBar() {
  const platform = withBrandingDefaults(null);
  const deployment = adminEnv.deployment;
  const locale = await readLocale();

  /*
   * Rendered twice and shown once, the way the navigation is: the drawer carries
   * it below 48rem and the bar from 48rem up, which is exactly where
   * `MobileMenu` stops existing. Two instances cannot disagree — `LocaleToggle`
   * reads `<html lang>` through `useSyncExternalStore` rather than holding a
   * copy of the locale — and the alternative, a single copy in the bar, is what
   * put the row into horizontal scroll at 320px: `.end` cannot shrink, and this
   * is a fifth item in a group sized for four.
   */
  const localeToggle = webEnv.enableLocaleSwitch ? <LocaleToggle initialLocale={locale} /> : null;

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
        >
          {localeToggle}
        </MobileMenu>
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
        {/* Hidden below 48rem, where the drawer above carries the same control. */}
        {localeToggle === null ? null : <div className={styles.wideOnly}>{localeToggle}</div>}
        <ForgetCredentialButton />
      </div>
    </header>
  );
}
