import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { Notice } from '@/components/ui/Notice';
import { content } from '@/content/en';
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
  const { conversations, userNames, teamNames } = await loadInbox(query);

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
        />
      </Stack>
    </SectionCard>
  );
}

/** Mirrors `InboxSection`'s frame, with the list's own skeleton inside it. */
export function InboxSectionSkeleton() {
  return (
    <SectionCard id="conversations" title={content.inbox.conversationsHeading}>
      <ConversationListSkeleton />
    </SectionCard>
  );
}
