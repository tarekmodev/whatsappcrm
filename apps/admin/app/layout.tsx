import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Figtree, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { cx } from '@/lib/cx';
import { directionOf } from '@/lib/locale/locale';
import { readLocale } from '@/lib/locale/read-locale';
import { content } from '~/content/en';
import './globals.css';

/**
 * The document, and the two things every operator screen shares: it is never
 * indexed, and it is never a tenant's brand.
 *
 * It renders no chrome and resolves no credential. Two groups sit under it —
 * `(console)` behind the gate, `(gate)` where the credential is presented — and
 * gating here would mean an operator could not reach the form that fixes it.
 *
 * ## No `readBranding`, and no theme cookie
 *
 * `apps/web`'s root layout resolves the tenant from the request host and paints
 * its colours before first paint. There is no tenant here: this console is
 * *ours*, on its own origin, and dressing the control plane in one customer's
 * logo is the one place white-labelling would actively mislead the person
 * reading it. The platform's own identity is the token layer's default.
 *
 * There is no theme toggle either (spec §2.1) — no account, nothing to hang one
 * off, and 0001's rule that the shell carries nothing for a feature the app does
 * not have. The console renders in the token layer's light theme.
 *
 * ## The locale *is* resolved here, unlike the theme (TAR-806)
 *
 * A cookie read, from `apps/web`'s own `readLocale` — same module and same
 * cookie name, because a locale is a reading preference rather than anything
 * this console needs to keep to itself.
 *
 * In a deployment the two consoles are different **hosts**, so the two cookies
 * are separate and an operator's choice here is their own. Locally they are not:
 * cookies are scoped by host and not by port (RFC 6265), so `localhost:3000` and
 * `localhost:3002` share one jar and switching either console switches both.
 * That is a property of cookies rather than of this app, and it is convenient
 * rather than harmful — but it is why a local check of "is this isolated" gives
 * the answer it does.
 *
 * It is resolved on the server rather than after hydration for the reason the
 * theme is: `dir` moves every element on the screen rather than recolouring
 * them, so a flash of the wrong one is a whole layout jumping. There is nothing
 * to correct after hydration and therefore no mismatch to suppress.
 */

export const metadata: Metadata = {
  title: { default: content.app.name, template: `%s · ${content.app.name}` },
  description: content.app.description,
  robots: { index: false, follow: false },
};

/**
 * The same face `apps/web` self-hosts, from the same `next/font` loader, so the
 * two consoles are one product to look at and neither fetches from a third party
 * at runtime.
 */
const bodyFont = Figtree({ subsets: ['latin'], display: 'swap', variable: '--font-sans' });

/**
 * The Arabic face, loaded the same way and for the same reason as in
 * `apps/web`'s root layout: Figtree carries no Arabic glyphs, so an operator
 * console at `lang="ar"` would fall through to whatever the machine happens to
 * have. The shared token layer's `[lang|='ar']` branch is what reads it, so
 * wiring the variable here is all this app needs.
 *
 * `preload: false` for the same reason too — no preload link on the critical
 * path of every route for a face an English document draws at most one glyph of
 * (the toggle's own endonym).
 */
const arabicFont = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  preload: false,
  variable: '--font-arabic',
});

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await readLocale();

  return (
    <html
      lang={locale}
      dir={directionOf(locale)}
      className={cx(bodyFont.variable, arabicFont.variable)}
    >
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
