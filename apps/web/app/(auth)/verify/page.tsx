import type { Metadata } from 'next';
import { content } from '@/content/en';
import { SignupVerifySection } from '@/features/auth/components/SignupVerifySection';

/**
 * Confirm a signup's email address. The target of the link `TenantSignupService`
 * mails out — kept in step with it through `routes.verifySignup()`, which
 * `routes.test.ts` pins against the API's `VERIFY_LINK_PATH`.
 *
 * The token arrives in the URL **fragment**, which the server never sees, so
 * everything below this file is client-rendered on purpose. That is the cost of
 * keeping a live credential out of the access logs, and it is paid here rather
 * than by putting the token in a query string — the same trade the invite and
 * reset screens make.
 *
 * `robots` comes from the `(auth)` layout and is inherited.
 */

export const metadata: Metadata = {
  title: content.auth.verifyTitle,
  description: content.auth.verifyDescription,
};

export default function VerifySignupPage() {
  return <SignupVerifySection />;
}
