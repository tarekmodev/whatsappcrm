import 'server-only';

import { cache } from 'react';
import { unstable_rethrow } from 'next/navigation';
import { withBrandingDefaults, type TenantBranding } from '@whatsappcrm/contracts';
import { getPublicTenant } from '@/lib/api/tenant';

/**
 * The resolved tenant's branding, for whatever host this request arrived on.
 *
 * ## The isolation rule, and how this file keeps it
 *
 * **No branding value may be held anywhere that outlives one request.** The URL
 * `/v1/tenant/public` is identical for every tenant — the tenant is the *host* —
 * so any cache keyed on the URL alone serves one tenant's logo and colours under
 * another tenant's domain. That is the single highest-severity bug this feature
 * can produce, and it is invisible in development, where there is one tenant.
 *
 * `cache()` from React is therefore the *only* memoisation here, and it is safe
 * for precisely the reason a `fetch` cache is not: its lifetime is one server
 * render pass. The root layout, the shell and the auth screen all need the same
 * branding, and without it that is three identical round-trips per page; with it
 * the value still cannot survive into another tenant's request. Nothing in this
 * module — and nothing that calls it — may promote that to a module-level
 * variable, a `unstable_cache`, or a `revalidate`.
 *
 * ## Why a failure is not an error
 *
 * This is on the render path of every page in the app, signed in or not. A
 * branding read that threw would 500 the sign-in screen because a colour could
 * not be fetched. It falls back to the platform defaults and logs instead, so the
 * worst outcome of an API outage is an unbranded console rather than no console.
 */
export const readBranding = cache(async (): Promise<TenantBranding> => {
  try {
    return withBrandingDefaults((await getPublicTenant()).branding);
  } catch (error) {
    // First, and before anything else looks at it. This read calls `headers()`
    // to name the tenant, and Next signals "this route cannot be prerendered"
    // by *throwing* — caught and turned into a fallback, that signal would be
    // swallowed and the route would be prerendered at build time with the
    // platform's brand baked in, for every tenant. `unstable_rethrow` is the
    // documented way to let a framework-controlled throw back out of a catch
    // that also has real failures to handle.
    unstable_rethrow(error);

    // Never swallowed: the server log keeps what the visitor must not be shown.
    console.error('Reading tenant branding failed; falling back to platform defaults', error);

    return withBrandingDefaults(null);
  }
});
