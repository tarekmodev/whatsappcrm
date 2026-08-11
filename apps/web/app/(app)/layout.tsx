import type { ReactNode } from 'react';
import { webEnv } from '@/lib/config/env';
import { verifySession } from '@/lib/session/session';
import { readTheme } from '@/lib/theme/read-theme';
import { AppHeader } from '@/components/shell/AppHeader';
import { NAV_ITEMS, visibleNavItems } from '@/components/shell/navigation';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { RoleStubSwitcher } from '@/components/shell/RoleStubSwitcher';
import { SignOutButton } from '@/components/shell/SignOutButton';
import { SkipLink } from '@/components/shell/SkipLink';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';

/**
 * The signed-in console shell. Composition only: it resolves the principal on the
 * server, filters the navigation once, and hands both to the shell components.
 *
 * A route group rather than a path segment, so every URL below it is unchanged —
 * `/inbox` is still `/inbox`. What the group buys is the ability for the
 * signed-out `(auth)` routes to render without this header and without a session.
 *
 * `verifySession` here is a convenience, not the gate: a layout does not re-render
 * on client navigation and does not decide whether the segments below it render, so
 * the gate that matters is the one every page and every authenticated read performs
 * for itself (`lib/api/authenticated.ts`). What this call buys is that a signed-out
 * visitor never sees a half-built shell before being sent to sign in.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const theme = await readTheme();
  const { principal, checker, isStubbed } = await verifySession();
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
            {/* Not offered against a stubbed principal: there is no session to end,
                and the button would look broken. */}
            {isStubbed ? null : <SignOutButton />}
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
