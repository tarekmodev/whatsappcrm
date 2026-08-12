import { loadConversationThread } from '@/features/inbox/thread.data';
import { InboxContextPanel } from './InboxContextPanel';

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
 */
export async function InboxContextSection({ conversationId }: { conversationId: string }) {
  const result = await loadConversationThread(conversationId);

  if (result.outcome === 'unavailable') {
    return null;
  }

  return <InboxContextPanel conversation={result.thread.conversation} />;
}
