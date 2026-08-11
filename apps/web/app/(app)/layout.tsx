import type { ReactNode } from 'react';
import { webEnv } from '@/lib/config/env';
import { verifySession } from '@/lib/session/session';
import { readTheme } from '@/lib/theme/read-theme';
import { readRailState } from '@/lib/shell/read-rail';
import { AppShell } from '@/components/shell/AppShell';
import { AppSidebar } from '@/components/shell/AppSidebar';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { NAV_ITEMS, visibleNavItems } from '@/components/shell/navigation';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { RoleStubSwitcher } from '@/components/shell/RoleStubSwitcher';
import { SignOutButton } from '@/components/shell/SignOutButton';
import { SkipLink } from '@/components/shell/SkipLink';

/**
 * The signed-in console shell. Composition only: it resolves the principal and
 * the stored rail width on the server, filters the navigation once, and hands
 * all three to the shell components.
 *
 * The frame is the rail beside the bar (`docs/design/0001-visual-design-language.md`);
 * `AppShell` owns the grid and `<main>`, and both the rail and the bar render
 * from the one filtered `NavItem[]`.
 *
 * A route group rather than a path segment, so every URL below it is unchanged —
 * `/inbox` is still `/inbox`. What the group buys is the ability for the
 * signed-out `(auth)` routes to render without this shell and without a session.
 *
 * `verifySession` here is a convenience, not the gate: a layout does not re-render
 * on client navigation and does not decide whether the segments below it render, so
 * the gate that matters is the one every page and every authenticated read performs
 * for itself (`lib/api/authenticated.ts`). What this call buys is that a signed-out
 * visitor never sees a half-built shell before being sent to sign in.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const theme = await readTheme();
  const railState = await readRailState();
  const { principal, checker, isStubbed } = await verifySession();
  const navItems = visibleNavItems(NAV_ITEMS, checker);

  const utilities = (
    <>
      <ThemeToggle initialTheme={theme} />
      {isStubbed && webEnv.enableRoleStub ? <RoleStubSwitcher role={principal.role} /> : null}
      {/* Not offered against a stubbed principal: there is no session to end,
          and the button would look broken. */}
      {isStubbed ? null : <SignOutButton />}
    </>
  );

  return (
    <>
      <SkipLink />
      <AppShell
        initialRailState={railState}
        rail={<AppSidebar items={navItems} />}
        bar={<AppTopBar items={navItems} principal={principal} utilities={utilities} />}
      >
        {children}
      </AppShell>
    </>
  );
}
