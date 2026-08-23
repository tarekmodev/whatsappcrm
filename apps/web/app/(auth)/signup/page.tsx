import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { content } from '@/content/en';
import { SignupForm } from '@/features/auth/components/SignupForm';

/**
 * Create a workspace (TAR-36, TAR-805). Composition only: read the host this
 * request arrived on, then hand it to the form.
 *
 * ## Why the host is read here and not in the form
 *
 * The form shows the address the customer is choosing as the hostname it will
 * actually become, and that hostname is `{slug}.{this host}` — the same
 * composition `TenantProvisioningService` performs on the other side. Reading it
 * from the request means the preview is right in every environment, including a
 * developer's `localhost:3000`, without the console holding a second copy of the
 * platform domain that could disagree with the API's.
 *
 * Server-side rather than from `window.location` in the client component,
 * because that value is unreadable during the server render — the preview would
 * be absent on first paint and appear a frame later, on the field somebody is
 * most likely to already be typing into.
 *
 * **This page belongs to the platform host.** There is no tenant until the
 * emailed link comes back, so nothing here resolves one, and the console never
 * links to it from a tenant's own white-labelled screens — see `routes.signup`.
 *
 * `robots` comes from the `(auth)` layout and is inherited. That is right even
 * for a page a deployment might want indexed: a public marketing site links here
 * deliberately, and TAR-800's operator surface is not this.
 */

export const metadata: Metadata = {
  title: content.auth.signupTitle,
  description: content.auth.signupDescription,
};

export default async function SignupPage() {
  const host = (await headers()).get('host');

  if (host === null || host === '') {
    // The same call `tenantRoutingHeaders` makes and the same answer: a request
    // with no `Host` is a proxy or runtime that is misconfigured, and an address
    // preview reading `acme.` on the product's first screen is a worse way to
    // find that out than a loud failure at the deploy.
    throw new Error('The incoming request carries no Host, so no workspace address can be shown.');
  }

  return <SignupForm platformHost={host} />;
}
