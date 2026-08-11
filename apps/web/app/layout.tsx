import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { content } from '@/content/en';
import { webEnv } from '@/lib/config/env';
import { resolveSession } from '@/lib/session/session';
import { parseTheme, THEME_COOKIE_NAME, type Theme } from '@/lib/theme/theme';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { AppHeader } from '@/components/shell/AppHeader';
import { NAV_ITEMS, visibleNavItems } from '@/components/shell/navigation';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { RoleStubSwitcher } from '@/components/shell/RoleStubSwitcher';
import { SkipLink } from '@/components/shell/SkipLink';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';
import './globals.css';

/**
 * The app shell. Composition only: it resolves the theme and the principal on the
 * server, filters the navigation once, and hands both to the shell components.
 *
 * The theme lands in `data-theme` on `<html>` in the *first* HTML response, which
 * is what makes the swap flash-free — there is no client-side correction after
 * hydration, and therefore no mismatch to suppress.
 */

export const metadata: Metadata = {
  title: content.app.name,
  description: content.app.description,
};

const DEFAULT_THEME: Theme = 'light';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const theme = parseTheme(cookieStore.get(THEME_COOKIE_NAME)?.value) ?? DEFAULT_THEME;
  const { principal, checker, isStubbed } = await resolveSession();
  const navItems = visibleNavItems(NAV_ITEMS, checker);

  return (
    <html lang="en" dir="ltr" data-theme={theme}>
      <body>
        <ToastProvider>
          <SkipLink />
          <AppHeader
            items={navItems}
            utilities={
              <>
                <ThemeToggle initialTheme={theme} />
                {isStubbed && webEnv.enableRoleStub ? (
                  <RoleStubSwitcher role={principal.role} />
                ) : null}
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
        </ToastProvider>
      </body>
    </html>
  );
}
