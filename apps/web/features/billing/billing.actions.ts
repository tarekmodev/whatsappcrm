'use server';

import { randomUUID } from 'node:crypto';
import { CheckoutRequestSchema, PortalRequestSchema } from '@whatsappcrm/contracts';
import { createCheckoutSession, createPortalSession } from '@/lib/api/billing';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';

/**
 * The two mutations on the billing surface. Both hand back a hosted URL for the
 * browser to follow; neither navigates on its own.
 *
 * **Why the redirect happens in the browser and not with `redirect()` here.**
 * `next/navigation`'s `redirect` throws, and a thrown server action unmounts
 * into the route's error boundary — which is precisely what must not happen on
 * the one button whose failure the user has to be able to read and press again.
 * More importantly the target is a *third-party origin*: a client navigation to
 * it is not something the router can do, so it would be a full page load either
 * way. Returning the URL keeps the failure path renderable in place.
 *
 * The URL is still validated before it is returned — `HostedSessionSchema` in
 * the API module refuses anything that is not an http(s) URL — so a compromised
 * or malfunctioning provider cannot hand the console a `javascript:` target on
 * the page where a user is most primed to follow a link without reading it.
 */

/** Path only; `routes.settingsBilling()` may carry return-from-checkout parameters. */
const BILLING_PATH = routes.settingsBilling().split('?')[0] ?? '/settings/billing';

export async function startCheckoutAction(planKey: string): Promise<ActionResult<{ url: string }>> {
  return runAction({
    permission: 'billing:manage',
    parser: CheckoutRequestSchema,
    input: {
      planKey,
      /*
       * Paths, not URLs, per the contract: the API composes them against the
       * tenant's own resolved origin. Sending an absolute URL from here would be
       * an open redirect that a payment provider would faithfully honour, on the
       * one page where the user is most primed to trust where they land.
       *
       * The plan rides on the success path so the page it returns to can tell a
       * completed upgrade from the plan the tenant was already on.
       */
      successPath: routes.settingsBilling({ checkout: 'succeeded', planKey }),
      cancelPath: routes.settingsBilling({ checkout: 'cancelled' }),
    },
    /*
     * Nothing to invalidate: the browser leaves for the provider's page and comes
     * back through a fresh navigation, and this route is `force-dynamic` anyway.
     * Revalidating would re-render a page the user is already leaving.
     */
    revalidate: null,
    label: 'Billing checkout',
    perform: async (parsed) => {
      /*
       * One key per deliberate click, minted here rather than inside the API
       * module so that *this* call is the intent it identifies.
       *
       * It is not the double-click guard — `useActionForm` holds an in-flight
       * ref for that, and it fires before a second action ever starts. What the
       * key buys is the retry: a checkout `POST` that times out after the
       * provider has already created the session must not create a second one
       * when the transport retries it.
       */
      const { url } = await createCheckoutSession(parsed, randomUUID());

      return { url };
    },
  });
}

export async function openBillingPortalAction(): Promise<ActionResult<{ url: string }>> {
  return runAction({
    permission: 'billing:manage',
    parser: PortalRequestSchema,
    input: { returnPath: BILLING_PATH },
    revalidate: null,
    label: 'Billing portal',
    perform: async (parsed) => {
      // Minted on the click and never stored: these sessions expire in minutes,
      // and a cached one is a dead link on a button whose whole purpose is to be
      // pressed.
      const { url } = await createPortalSession(parsed);

      return { url };
    },
  });
}
