import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { Notice } from '@/components/ui/Notice';
import { content } from '@/content/en';
import { loadInbox, type InboxQuery } from '../inbox.data';
import { ConversationList, ConversationListSkeleton } from './ConversationList';

/**
 * Fetches and renders the conversation list. Usage: inside a Suspense boundary on
 * the inbox page, with `InboxSectionSkeleton` as the fallback.
 */
export async function InboxSection({ query }: { query: InboxQuery }) {
  const { conversations, assigneeNames, teamNames, wasScopeNarrowed } = await loadInbox(query);

  return (
    <SectionCard id="conversations" title={content.inbox.conversationsHeading}>
      <Stack gap="3">
        {wasScopeNarrowed ? (
          // The API narrows the scope silently; saying so is what stops an agent
          // wondering why a shared supervisor link shows so little.
          <Notice tone="info">{content.inbox.scopeNarrowedNotice}</Notice>
        ) : null}
        <ConversationList
          conversations={conversations}
          assigneeNames={assigneeNames}
          teamNames={teamNames}
          isAllScope={query.effectiveScope === 'all'}
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
