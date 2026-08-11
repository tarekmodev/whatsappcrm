import type { ReactNode } from 'react';
import { webEnv } from '@/lib/config/env';
import { resolveSession } from '@/lib/session/session';
import { readTheme } from '@/lib/theme/read-theme';
import { AppHeader } from '@/components/shell/AppHeader';
import { NAV_ITEMS, visibleNavItems } from '@/components/shell/navigation';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { RoleStubSwitcher } from '@/components/shell/RoleStubSwitcher';
import { SkipLink } from '@/components/shell/SkipLink';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';

/**
 * The signed-in console shell. Composition only: it resolves the principal on the
 * server, filters the navigation once, and hands both to the shell components.
 *
 * A route group rather than a path segment, so every URL below it is unchanged —
 * `/inbox` is still `/inbox`. What the group buys is the ability for the
 * signed-out `(auth)` routes to render without this header and without a session.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const theme = await readTheme();
  const { principal, checker, isStubbed } = await resolveSession();
  const navItems = visibleNavItems(NAV_ITEMS, checker);

  return (
    <>
      <SkipLink />
      <AppHeader
        items={navItems}
        utilities={
          <>
            <ThemeToggle initialTheme={theme} />
            {isStubbed && webEnv.enableRoleStub ? <RoleStubSwitcher role={principal.role} /> : null}
          </>
        }
      />
      {/*
        `tabIndex={-1}` makes the landmark focusable programmatically but keeps
        it out of the tab order — needed by the skip link and as the fallback
        target when a dialog's invoker no longer exists on close.
      */}
      <main id={MAIN_CONTENT_ID} tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
