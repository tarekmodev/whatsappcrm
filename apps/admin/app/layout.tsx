import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Figtree } from 'next/font/google';
import { ToastProvider } from '@/components/ui/ToastProvider';
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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr" className={bodyFont.variable}>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
