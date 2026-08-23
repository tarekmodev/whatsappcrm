import type { ReactNode } from 'react';
import { withBrandingDefaults } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { requirePlatformCredential } from '@/lib/admin/platform-credential';
import { readTheme } from '@/lib/theme/read-theme';
import { readRailState } from '@/lib/shell/read-rail';
import { AppShell } from '@/components/shell/AppShell';
import { AppSidebar } from '@/components/shell/AppSidebar';
import { AdminTopBar } from '@/components/shell/AdminTopBar';
import { ADMIN_NAV_ITEMS } from '@/components/shell/admin-navigation';
import { SkipLink } from '@/components/shell/SkipLink';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { AdminSignOutButton } from '@/features/platform-admin/components/AdminSignOutButton';

/**
 * The platform-operator shell. Composition only: it resolves the stored rail
 * width, checks that this request carries a credential, and hands the frame to
 * the same `AppShell` the tenant console uses.
 *
 * The frame, the rail, the drawer and the collapse behaviour are all the console's
 * own components — one grid, one navigation renderer, one set of tokens — so the
 * operator surface cannot drift into a second design. What differs is the data
 * they render from: `ADMIN_NAV_ITEMS` instead of the permission-filtered tenant
 * nav, and the platform's identity instead of the host's tenant.
 *
 * `requirePlatformCredential` here is a convenience, not the gate, for exactly the
 * reason `(app)/layout.tsx` gives about `verifySession`: a layout does not
 * re-render on client navigation and does not decide whether the segments below
 * it render. The gate that matters is the one every page and every admin read
 * performs for itself (`lib/api/admin.ts`). What this buys is that an operator
 * with no credential never sees a half-built shell before being sent to present
 * one.
 */
export default async function PlatformAdminConsoleLayout({ children }: { children: ReactNode }) {
  await requirePlatformCredential();

  const theme = await readTheme();
  const railState = await readRailState();
  /*
   * The platform's own name and mark, not the host's tenant — see
   * `(gate)/layout.tsx` for why that distinction is load-bearing rather than
   * cosmetic on this surface. A pure function of `null`, so the shell makes no
   * branding round-trip.
   */
  const platform = withBrandingDefaults(null);

  const utilities = (
    <>
      <ThemeToggle initialTheme={theme} />
      <AdminSignOutButton />
    </>
  );

  return (
    <>
      <SkipLink />
      <AppShell
        initialRailState={railState}
        rail={
          <AppSidebar
            items={ADMIN_NAV_ITEMS}
            branding={platform}
            homeHref={routes.adminTenants()}
            navLabel={content.platformAdmin.nav.label}
          />
        }
        bar={<AdminTopBar items={ADMIN_NAV_ITEMS} branding={platform} utilities={utilities} />}
      >
        {children}
      </AppShell>
    </>
  );
}
