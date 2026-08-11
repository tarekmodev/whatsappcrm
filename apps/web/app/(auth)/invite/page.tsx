import type { Metadata } from 'next';
import { content } from '@/content/en';
import { InviteAcceptSection } from '@/features/auth/components/InviteAcceptSection';

/**
 * Invitation acceptance. Composition only.
 *
 * The section owns every state because the token is in the URL fragment, which
 * the server never receives — there is nothing for this file to read.
 */

export const metadata: Metadata = {
  title: `${content.auth.inviteTitle} · ${content.app.name}`,
  description: content.auth.inviteDescription,
  // Personal, single-use and short-lived. Nothing here should ever be crawled.
  robots: { index: false, follow: false },
};

export default function InvitePage() {
  return <InviteAcceptSection />;
}
