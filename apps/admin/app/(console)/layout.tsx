import type { ReactNode } from 'react';
import { withBrandingDefaults } from '@whatsappcrm/contracts';
import { AppShell } from '@/components/shell/AppShell';
import { AppSidebar } from '@/components/shell/AppSidebar';
import { SkipLink } from '@/components/shell/SkipLink';
import { readRailState } from '@/lib/shell/read-rail';
import { content } from '~/content/en';
import { routes } from '~/lib/routes';
import { requireCredential } from '~/lib/credential';
import { ADMIN_NAV_ITEMS } from '~/features/shell/navigation';
import { AdminBar } from '~/features/shell/components/AdminBar';

/**
 * The operator shell. Composition only: it resolves the stored rail width,
 * checks that this request carries a credential, and hands the frame to the same
 * `AppShell` the tenant console uses.
 *
 * **The frame is 0001's console frame, unchanged** (spec §2.1) — rail, bar,
 * canvas, `AppShell`'s geometry. An operator console that invents a second frame
 * is a second design system. What differs is the data it renders from: three
 * fixed destinations instead of a permission-filtered nav, and the platform's own
 * identity instead of the host's tenant.
 *
 * `requireCredential` here is a convenience, not the gate — a layout does not
 * re-render on client navigation and does not decide whether the segments below
 * it render. The gate that matters is the one every screen and every action
 * performs for itself. What this buys is that an operator with no credential
 * never sees a half-built shell before being sent to present one.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  await requireCredential();

  const railState = await readRailState();
  /*
   * The platform's own name and mark, not the host's tenant — see the root
   * layout for why that distinction is load-bearing rather than cosmetic. A pure
   * function of `null`, so the shell makes no branding round-trip.
   */
  const platform = withBrandingDefaults(null);

  return (
    <>
      <SkipLink />
      <AppShell
        initialRailState={railState}
        rail={
          <AppSidebar
            items={ADMIN_NAV_ITEMS}
            branding={platform}
            homeHref={routes.tenants()}
            navLabel={content.nav.label}
          />
        }
        bar={<AdminBar />}
      >
        {children}
      </AppShell>
    </>
  );
}
