import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { content } from '@/content/en';
import { readTheme } from '@/lib/theme/read-theme';
import { ToastProvider } from '@/components/ui/ToastProvider';
import './globals.css';

/**
 * The document. Everything above the route groups and nothing else: the language
 * and direction, the resolved theme, and the one notification system.
 *
 * It deliberately renders **no chrome and resolves no principal**. Two groups sit
 * under it and they need different shells — `(app)` is the signed-in console with
 * its header and navigation, `(auth)` is the signed-out surface where password
 * recovery lives (TAR-61) and where TAR-60's login screen will. Resolving the
 * session here would mean a logged-out visitor could not open a reset link
 * without hitting a 401 first.
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
  const theme = await readTheme();

  return (
    <html lang="en" dir="ltr" data-theme={theme}>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
