import type { Metadata } from 'next';
import { content } from '@/content/en';
import { InviteAcceptSection } from '@/features/auth/components/InviteAcceptSection';

/**
 * Accept an invitation. The target of the link TAR-55 mails out — kept in step
 * with it through `routes.invite()`.
 *
 * The token arrives in the URL **fragment**, which the server never sees, so
 * everything below this file is client-rendered on purpose. That is the cost of
 * keeping a live credential out of the access logs, and it is paid here rather
 * than by putting the token in a query string.
 *
 * `robots` comes from the `(auth)` layout and is inherited.
 */

export const metadata: Metadata = {
  title: content.auth.inviteTitle,
  description: content.auth.inviteDescription,
};

export default function InvitePage() {
  return <InviteAcceptSection />;
}
