import { Suspense } from 'react';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { hasBotEngaged } from '@/features/inbox/bot-state';
import { loadConversationThread } from '@/features/inbox/thread.data';
import { HandoffPanelSkeleton } from './HandoffPanel';
import { HandoffSection } from './HandoffSection';
import { InboxContextPanel } from './InboxContextPanel';
import { TicketSummarySection, TicketSummarySkeleton } from './TicketSummarySection';

/**
 * Fetches the open conversation for the context column. Usage: inside a Suspense
 * boundary on the inbox page, keyed on the conversation id, with
 * `InboxContextPanelSkeleton` as the fallback.
 *
 * The read is request-cached, so this costs no round trip on top of the thread's
 * own — the two are separate boundaries so a slow thread does not hold up a
 * contact card, not because they fetch different things.
 *
 * A thread this reader may not open renders nothing here: the thread pane beside
 * it already says so, and a second card repeating it would be the same refusal
 * twice.
 *
 * The chatbot card is a *second* endpoint and gets its own Suspense and error
 * boundary inside the slot. It is asked for only when the chatbot has actually
 * been on the conversation — `botState === 'off'` could only ever answer `404`,
 * and a request that can only 404 is one the console should not make.
 */
export async function InboxContextSection({ conversationId }: { conversationId: string }) {
  const result = await loadConversationThread(conversationId);

  if (result.outcome === 'unavailable') {
    return null;
  }

  const { conversation } = result.thread;

  const { ticketId } = conversation;

  return (
    <InboxContextPanel
      conversation={conversation}
      chatbot={
        hasBotEngaged(conversation.botState) ? (
          <SectionErrorBoundary>
            <Suspense fallback={<HandoffPanelSkeleton />}>
              <HandoffSection conversationId={conversationId} />
            </Suspense>
          </SectionErrorBoundary>
        ) : undefined
      }
      ticket={
        // A third endpoint, and the same rule as the chatbot card: asked for
        // only when there is something to ask about — `ticketId` is null until
        // the auto-linker has run, and a read that can only 404 is one the
        // console should not make.
        ticketId === null ? undefined : (
          <SectionErrorBoundary>
            <Suspense fallback={<TicketSummarySkeleton />}>
              <TicketSummarySection ticketId={ticketId} />
            </Suspense>
          </SectionErrorBoundary>
        )
      }
    />
  );
}
