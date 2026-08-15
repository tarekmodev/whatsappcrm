import { content } from '@/content/en';
import { loadHandoff } from '@/features/inbox/handoff.data';
import { HandoffPanel } from './HandoffPanel';
import styles from './HandoffPanel.module.css';

/**
 * Fetches the chatbot's handoff summary for the open conversation. Usage: inside
 * a Suspense boundary in the inbox context column, keyed on the conversation id,
 * with `HandoffPanelSkeleton` as the fallback.
 *
 * Its own boundary, separate from the contact card's: it is a second endpoint,
 * and a slow or failing summary of what a bot did must not hold up — or take
 * down — the panel that says who the customer is.
 *
 * A conversation the chatbot has engaged but not handed over renders the "not
 * handed over" line rather than nothing. That is the `bot_active` case, and an
 * empty card there would read as a summary that failed to load.
 */
export async function HandoffSection({ conversationId }: { conversationId: string }) {
  const result = await loadHandoff(conversationId);

  if (result.outcome === 'none') {
    return <p className={styles.detail}>{content.inbox.handoffNone}</p>;
  }

  return <HandoffPanel handoff={result.handoff} />;
}
