import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Figtree } from 'next/font/google';
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

/**
 * The console's geometric sans (0001). `next/font` self-hosts it at build time
 * and emits the `@font-face` itself, so there is no request to a third party at
 * runtime and no layout shift to design around: the variable it exposes is what
 * `--scale-font-family-sans` reads.
 *
 * One family, one variable axis. A second weight file is a second download for a
 * difference the type scale already expresses.
 */
const bodyFont = Figtree({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await readTheme();

  return (
    <html lang="en" dir="ltr" data-theme={theme} className={bodyFont.variable}>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
