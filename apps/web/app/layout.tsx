import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Figtree } from 'next/font/google';
import { content } from '@/content/en';
import { readTheme } from '@/lib/theme/read-theme';
import { readBranding } from '@/lib/branding/read-branding';
import { brandStyleSheet } from '@/lib/branding/brand-style';
import { ToastProvider } from '@/components/ui/ToastProvider';
import './globals.css';

/**
 * The document. Everything above the route groups and nothing else: the language
 * and direction, the resolved theme, the tenant's brand tokens, and the one
 * notification system.
 *
 * It deliberately renders **no chrome and resolves no principal**. Two groups sit
 * under it and they need different shells — `(app)` is the signed-in console with
 * its header and navigation, `(auth)` is the signed-out surface where login and
 * password recovery live. Resolving the session here would mean a logged-out
 * visitor could not open a reset link without hitting a 401 first.
 *
 * The theme lands in `data-theme` on `<html>` in the *first* HTML response, which
 * is what makes the swap flash-free — there is no client-side correction after
 * hydration, and therefore no mismatch to suppress. The tenant's colours land the
 * same way and for the same reason: white-labelling that arrived after hydration
 * would show every visitor the platform's green first (TAR-29).
 *
 * ## Why the branding read is here and not lower
 *
 * It is above both groups because the **sign-in screen has to be branded before
 * anyone has a session** — that is TAR-35's requirement and the reason
 * `GET /v1/tenant/public` is unauthenticated. Doing it once here also means the
 * shell, the auth screen and the metadata below share one request-scoped read
 * (`readBranding`) rather than three round-trips.
 */

/**
 * Per-request, because the title and the favicon are the tenant's. `readBranding`
 * is request-cached, so this costs nothing beyond the read the layout already
 * makes, and a failed read falls back to the platform defaults rather than
 * failing the page.
 */
export async function generateMetadata(): Promise<Metadata> {
  const branding = await readBranding();

  return {
    /*
     * A template, not a string, and this is the whole of "the product name
     * replaces the platform name in the browser tab". A route exports a plain
     * `title` — `Branding`, `Inbox` — and Next renders it as
     * `Branding · Acme Support`. Without it, every route would have to resolve
     * the tenant for itself through `generateMetadata`, which is a per-route
     * async read of a value the root layout already holds.
     */
    title: { default: branding.productName, template: `%s · ${branding.productName}` },
    description: content.app.description,
    // Only when the tenant has uploaded one. Next falls back to the app's own
    // icon convention otherwise, rather than requesting a route that 404s.
    ...(branding.favicon === null
      ? {}
      : { icons: { icon: [{ url: branding.favicon.path, type: branding.favicon.mimeType }] } }),
  };
}

/**
 * The console's geometric sans (0001). `next/font` self-hosts it at build time
 * and emits the `@font-face` itself, so there is no request to a third party at
 * runtime and no layout shift to design around: the variable it exposes is what
 * `--scale-font-family-sans` reads.
 *
 * Not tenant-configurable, and that is the closed list in TAR-29: colours, logo,
 * favicon, product name and support email. A per-tenant font is a second download
 * on the critical path for every visitor.
 */
const bodyFont = Figtree({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [theme, branding] = await Promise.all([readTheme(), readBranding()]);

  return (
    <html lang="en" dir="ltr" data-theme={theme} className={bodyFont.variable}>
      <body>
        {/*
          React hoists this into `<head>`. `precedence` is what makes the hoist
          deterministic rather than dependent on where in the tree it was
          rendered; the selectors carry the cascade themselves, so the block wins
          wherever it lands (see `brand-style.ts`).

          `dangerouslySetInnerHTML` on a `<style>` is the documented way to emit
          CSS text and is not an injection surface here: every value in the sheet
          is a `#rrggbb` string produced by `brandCssVariables`, which throws on
          anything else. No tenant-supplied text reaches it.
        */}
        <style
          precedence="tenant-branding"
          href="tenant-branding"
          dangerouslySetInnerHTML={{ __html: brandStyleSheet(branding) }}
        />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
