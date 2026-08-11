import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { verifySession } from '@/lib/session/session';
import { loadConversationThread } from '@/features/inbox/thread.data';
import { nameFor } from '@/features/inbox/directory.data';
import { EmptyState } from '@/components/ui/EmptyState';
import { InternalNotesPanel, InternalNotesPanelSkeleton } from './InternalNotesPanel';
import { MessageList, MessageListSkeleton } from './MessageList';
import { ThreadHeader, ThreadHeaderSkeleton, type ThreadQuery } from './ThreadHeader';

/**
 * The open conversation: its header, its messages and its internal notes.
 * Usage: inside a Suspense boundary on the inbox page, keyed on the
 * conversation id, with `ThreadSectionSkeleton` as the fallback.
 *
 * Two cards rather than one, because they fail and load independently: a notes
 * read that errors must not take the thread down with it, and the page wraps
 * each in its own boundary.
 */

export interface ThreadSectionProps {
  conversationId: string;
  /** The list's filters, so the small-screen back link returns to the same view. */
  query: ThreadQuery;
}

export async function ThreadSection({ conversationId, query }: ThreadSectionProps) {
  const [session, result] = await Promise.all([
    verifySession(),
    loadConversationThread(conversationId),
  ]);

  if (result.outcome === 'unavailable') {
    return <ThreadUnavailable />;
  }

  const { conversation, messages, hasOlderMessages, notes, userNames, teamNames } = result.thread;

  return (
    <Stack gap="4">
      <SectionCard id="conversation" title={content.inbox.threadHeading}>
        <Stack gap="4">
          <ThreadHeader
            conversation={conversation}
            assigneeName={nameFor(userNames, conversation.assignedUserId)}
            teamName={nameFor(teamNames, conversation.assignedTeamId)}
            canAssign={session.checker.can('conversation:assign')}
            currentUserId={session.principal.userId}
            query={query}
          />
          <MessageList
            messages={messages}
            senderNames={userNames}
            hasOlderMessages={hasOlderMessages}
          />
        </Stack>
      </SectionCard>

      <SectionCard id="internal-notes" title={content.notes.heading}>
        <InternalNotesPanel
          conversationId={conversation.id}
          notes={notes}
          authorNames={userNames}
          canWrite={session.checker.can('conversation:note')}
        />
      </SectionCard>
    </Stack>
  );
}

/**
 * What the thread pane shows for an id this reader may not open — a shared
 * supervisor link, or a thread claimed by somebody else since it was listed.
 *
 * The same card frame the real thread uses, and no Retry: the answer will not
 * change on a second attempt, so offering one would be a button that cannot work.
 * The list beside it is untouched.
 */
function ThreadUnavailable() {
  return (
    <SectionCard id="conversation" title={content.inbox.threadHeading}>
      <EmptyState
        heading={content.inbox.threadUnavailableHeading}
        body={content.inbox.threadUnavailableBody}
      />
    </SectionCard>
  );
}

/** Mirrors `ThreadSection`: the same two cards, each holding its own skeleton. */
export function ThreadSectionSkeleton({ query }: { query: ThreadQuery }) {
  return (
    <Stack gap="4">
      <SectionCard id="conversation" title={content.inbox.threadHeading}>
        <Stack gap="4">
          <ThreadHeaderSkeleton query={query} />
          <MessageListSkeleton />
        </Stack>
      </SectionCard>

      <SectionCard id="internal-notes" title={content.notes.heading}>
        <InternalNotesPanelSkeleton />
      </SectionCard>
    </Stack>
  );
}
