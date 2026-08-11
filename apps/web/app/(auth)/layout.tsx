import type { ReactNode } from 'react';
import { AuthShell } from '@/components/shell/AuthShell';
import { resolveTheme } from '@/lib/theme/resolve-theme';

/**
 * The signed-out shell. Composition only.
 *
 * It resolves no session — that is the whole reason this group exists. The theme
 * cookie is still read here so somebody who set dark mode and then signed out
 * lands on the sign-in screen in the theme they chose, with no flash.
 */

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const theme = await resolveTheme();

  return <AuthShell theme={theme}>{children}</AuthShell>;
}
