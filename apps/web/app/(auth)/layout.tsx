import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { AuthShell } from '@/components/shell/AuthShell';
import { parseTheme, THEME_COOKIE_NAME, type Theme } from '@/lib/theme/theme';

/**
 * The signed-out shell. Composition only.
 *
 * It resolves no session — that is the whole reason this group exists. The theme
 * cookie is still read here so somebody who set dark mode and then signed out
 * lands on the sign-in screen in the theme they chose, with no flash.
 */

const DEFAULT_THEME: Theme = 'light';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const theme = parseTheme(cookieStore.get(THEME_COOKIE_NAME)?.value) ?? DEFAULT_THEME;

  return <AuthShell theme={theme}>{children}</AuthShell>;
}
