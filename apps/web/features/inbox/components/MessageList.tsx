'use client';

import type { MessageResponse } from '@whatsappcrm/contracts';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { Notice } from '@/components/ui/Notice';
import { useContent } from '@/lib/content';
import { THREAD_SKELETON_COUNT } from '@/features/inbox/constants';
import { useStickToBottom } from '@/features/inbox/useStickToBottom';
import { MessageBubble, MessageBubbleSkeleton } from './MessageBubble';
import styles from './MessageList.module.css';

/**
 * The thread. Usage: `<MessageList messages={…} senderNames={…} hasOlderMessages={…} />`.
 *
 * A scroll container rather than a growing page, so the composer (TAR-20g) stays
 * where an agent left it. The container is a labelled region with a tab stop:
 * a scrollable box that keyboard users cannot reach is a box they cannot read.
 */

export interface MessageListProps {
  /** Oldest first — reading order, and the order `thread.data.ts` returns. */
  messages: readonly MessageResponse[];
  senderNames: ReadonlyMap<string, string>;
  hasOlderMessages: boolean;
}

export function MessageList({ messages, senderNames, hasOlderMessages }: MessageListProps) {
  const content = useContent();
  const newest = messages.at(-1) ?? null;
  const scrollerRef = useStickToBottom(newest?.id ?? null);

  if (messages.length === 0) {
    return <EmptyState heading={content.thread.emptyHeading} body={content.thread.emptyBody} />;
  }

  return (
    <div className={styles.wrapper}>
      {hasOlderMessages ? (
        // Said rather than implied: an agent scrolling to the top of a page and
        // finding no more must know whether that is the start of the
        // conversation or the start of what was fetched. Paging further back is
        // a follow-up, and this is what makes its absence visible.
        <Notice tone="info">{content.thread.olderMessagesNotice(messages.length)}</Notice>
      ) : null}
      <div
        ref={scrollerRef}
        className={styles.scroller}
        role="region"
        aria-label={content.thread.messagesHeading}
        tabIndex={0}
      >
        <ol className={styles.list}>
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              senderName={
                message.sentByUserId === null
                  ? null
                  : (senderNames.get(message.sentByUserId) ?? null)
              }
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * Mirrors `MessageList`: the same scroll container at the same height, the same
 * list, and alternating bubble skeletons — so the swap to real messages moves
 * nothing.
 */
export function MessageListSkeleton() {
  const content = useContent();

  return (
    <div className={styles.wrapper}>
      <LoadingAnnouncement label={content.thread.loading} />
      <div className={styles.scroller}>
        <ol className={styles.list} aria-hidden="true">
          {Array.from({ length: THREAD_SKELETON_COUNT }, (_unused, index) => (
            <MessageBubbleSkeleton key={index} index={index} />
          ))}
        </ol>
      </div>
    </div>
  );
}
