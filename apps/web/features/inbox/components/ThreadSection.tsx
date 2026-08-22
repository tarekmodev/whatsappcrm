import { content } from '@/content/en';
import { verifySession } from '@/lib/session/session';
import { loadConversationThread } from '@/features/inbox/thread.data';
import { loadCannedResponses } from '@/features/inbox/canned-responses.data';
import { nameFor } from '@/features/inbox/directory.data';
import { isConversationUnclaimed } from '@/features/inbox/conversation-hold';
import { EmptyState } from '@/components/ui/EmptyState';
import { serviceWindowAt } from '@/features/inbox/service-window';
import { InternalNotesPanel } from './InternalNotesPanel';
import { MessageComposer, MessageComposerSkeleton } from './MessageComposer';
import { MessageList, MessageListSkeleton } from './MessageList';
import { ThreadComposerDock } from './ThreadComposerDock';
import { ThreadComposerTabs } from './ThreadComposerTabs';
import { ThreadHeader, ThreadHeaderSkeleton, type ThreadQuery } from './ThreadHeader';
import styles from './ThreadSection.module.css';

/**
 * The open conversation: its header, its messages, and the box an agent types
 * into. Usage: inside a Suspense boundary on the inbox page, keyed on the
 * conversation id, with `ThreadSectionSkeleton` as the fallback.
 *
 * ## Three parts, one column
 *
 * The header does not scroll, the message stream does, and the composer is
 * pinned to the foot — so the reply box is on screen whatever the length of the
 * conversation. The column is `InboxLayout`'s, and it is named there; this is
 * only what fills it, which is why there is no card and no heading here. The
 * contact's name at the top is the thread's visible header.
 *
 * The internal notes used to be a second card below the thread; they
 * are now the composer's other tab, which is where the reference layout puts
 * them and — more to the point — where they are actually used: an agent writes a
 * note *instead of* a reply, and the two boxes stacked one above the other made
 * that a scroll rather than a choice. They are still separate entities behind
 * separate endpoints, and `ThreadComposerTabs` is what makes the destination an
 * explicit, labelled decision.
 *
 * They were never independent failures despite the old comment: both come out of
 * the one `loadConversationThread` read, so one card is also the honest number of
 * error boundaries.
 */

export interface ThreadSectionProps {
  conversationId: string;
  /** The list's filters, so the small-screen back link returns to the same view. */
  query: ThreadQuery;
}

export async function ThreadSection({ conversationId, query }: ThreadSectionProps) {
  // Concurrent, and the canned-response read is deliberately not gated on the
  // permission behind it: `verifySession` resolves alongside rather than before,
  // and a role without `canned_response:read` gets a `forbidden` the loader
  // already turns into an empty library. Waiting for the checker to ask a
  // question every current role answers yes to would serialise the two reads.
  const [session, result, cannedResponses] = await Promise.all([
    verifySession(),
    loadConversationThread(conversationId),
    loadCannedResponses(),
  ]);

  if (result.outcome === 'unavailable') {
    return <ThreadUnavailable />;
  }

  const { conversation, messages, hasOlderMessages, notes, userNames, teamNames } = result.thread;
  // The shared pool is readable by everyone and writable by nobody (TAR-186):
  // the API refuses a send, a note and a status change on a thread nobody holds,
  // so the console shuts both boxes rather than letting an agent type a reply
  // into a 409. Claiming is the control directly above them.
  const isUnclaimed = isConversationUnclaimed(
    conversation.assignedUserId,
    conversation.assignedTeamId,
  );

  return (
    <div className={styles.thread}>
      <div className={styles.header}>
        <ThreadHeader
          conversation={conversation}
          assigneeName={nameFor(userNames, conversation.assignedUserId)}
          teamName={nameFor(teamNames, conversation.assignedTeamId)}
          holdPermissions={{
            canClaim: session.checker.can('conversation:claim'),
            canAssign: session.checker.can('conversation:assign'),
          }}
          currentUserId={session.principal.userId}
          query={query}
          isUnclaimed={isUnclaimed}
        />
      </div>

      <div className={styles.stream}>
        <MessageList
          messages={messages}
          senderNames={userNames}
          hasOlderMessages={hasOlderMessages}
        />
      </div>

      <ThreadComposerDock>
        <ThreadComposerTabs
          reply={
            /* The window is evaluated here, on the server, and handed down as
               the composer's starting point — so the first client render
               produces the markup that was sent and the countdown does not
               hydrate into a mismatch. The composer owns it from there. */
            <MessageComposer
              conversationId={conversation.id}
              serviceWindowExpiresAt={conversation.serviceWindowExpiresAt}
              initialWindow={serviceWindowAt(conversation.serviceWindowExpiresAt, new Date())}
              canSend={session.checker.can('conversation:send')}
              isUnclaimed={isUnclaimed}
              cannedResponses={cannedResponses}
            />
          }
          note={
            <InternalNotesPanel
              conversationId={conversation.id}
              notes={notes}
              authorNames={userNames}
              canWrite={session.checker.can('conversation:note')}
              isUnclaimed={isUnclaimed}
            />
          }
        />
      </ThreadComposerDock>
    </div>
  );
}

/**
 * What the thread pane shows for an id this reader may not open — a shared
 * supervisor link, or a thread claimed by somebody else since it was listed.
 *
 * The same column frame the real thread uses, and no Retry: the answer will not
 * change on a second attempt, so offering one would be a button that cannot work.
 * The list beside it is untouched.
 */
function ThreadUnavailable() {
  return (
    <div className={styles.thread}>
      <div className={styles.state}>
        <EmptyState
          icon="warning"
          title={content.inbox.threadUnavailableHeading}
          description={content.inbox.threadUnavailableBody}
        />
      </div>
    </div>
  );
}

/**
 * Mirrors `ThreadSection`: the same full-height column, the same fixed header,
 * the same stream filling what is left, and the same pinned composer — so the
 * swap to a real conversation moves nothing, at the moment an agent is watching
 * it most closely.
 *
 * The tab strip is not drawn. It is chrome the real component paints instantly
 * and identically whatever the data says, and a placeholder for it would be a
 * skeleton of something that never loads — the composer skeleton below already
 * reserves the box's height.
 */
export function ThreadSectionSkeleton({ query }: { query: ThreadQuery }) {
  return (
    <div className={styles.thread}>
      <div className={styles.header}>
        <ThreadHeaderSkeleton query={query} />
      </div>

      <div className={styles.stream}>
        <MessageListSkeleton />
      </div>

      <ThreadComposerDock>
        <MessageComposerSkeleton />
      </ThreadComposerDock>
    </div>
  );
}
