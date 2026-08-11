import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { Notice } from '@/components/ui/Notice';
import { content } from '@/content/en';
import { verifySession } from '@/lib/session/session';
import { loadInbox, type InboxQuery } from '@/features/inbox/inbox.data';
import { ConversationList, ConversationListSkeleton } from './ConversationList';

/**
 * Fetches and renders the conversation list. Usage: inside a Suspense boundary
 * on the inbox page, with `InboxSectionSkeleton` as the fallback.
 */

export interface InboxSectionProps {
  query: InboxQuery;
  /** The open thread, so the list can mark it. `null` for the list-only view. */
  selectedId: string | null;
  /** True when the API answers `all` with less than the whole tenant. */
  isScopeNarrowed: boolean;
}

export async function InboxSection({ query, selectedId, isScopeNarrowed }: InboxSectionProps) {
  const [session, { conversations, userNames, teamNames }] = await Promise.all([
    verifySession(),
    loadInbox(query),
  ]);
  // Request-cached, so this costs no extra round trip on top of the page's own
  // session check.
  const claim = session.checker.can('conversation:assign')
    ? { currentUserId: session.principal.userId }
    : null;

  return (
    <SectionCard id="conversations" title={content.inbox.conversationsHeading}>
      <Stack gap="3">
        {isScopeNarrowed ? (
          // The API narrows `all` rather than refusing it; saying so is what
          // stops an agent wondering why a shared supervisor link shows so
          // little.
          <Notice tone="info">{content.inbox.scopeNarrowedAllNotice}</Notice>
        ) : null}
        <ConversationList
          conversations={conversations}
          userNames={userNames}
          teamNames={teamNames}
          query={{ scope: query.scope, status: query.status }}
          selectedId={selectedId}
          claim={claim}
        />
      </Stack>
    </SectionCard>
  );
}

/**
 * Mirrors `InboxSection`'s frame, with the list's own skeleton inside it.
 *
 * `hasClaim` matches what the principal's real rows will carry, so a supervisor's
 * taller badge row is reserved rather than appearing when the data lands.
 */
export function InboxSectionSkeleton({ hasClaim = false }: { hasClaim?: boolean }) {
  return (
    <SectionCard id="conversations" title={content.inbox.conversationsHeading}>
      <ConversationListSkeleton hasClaim={hasClaim} />
    </SectionCard>
  );
}
