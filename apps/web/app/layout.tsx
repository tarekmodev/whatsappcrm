import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { resolveTheme } from '@/lib/theme/resolve-theme';
import './globals.css';

/**
 * The document. Composition only: it resolves the theme on the server and opens
 * the one toast region the whole app shares.
 *
 * Deliberately session-free. The signed-in shell — header, navigation, principal
 * — belongs to `(app)/layout.tsx`, because `(auth)/` renders for somebody who by
 * definition has no session yet, and a layout that demanded one here would make
 * the login screen unreachable.
 *
 * The theme lands in `data-theme` on `<html>` in the *first* HTML response, which
 * is what makes the swap flash-free — there is no client-side correction after
 * hydration, and therefore no mismatch to suppress.
 */

export const metadata: Metadata = {
  title: content.app.name,
  description: content.app.description,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await resolveTheme();

  return (
    <html lang="en" dir="ltr" data-theme={theme}>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
