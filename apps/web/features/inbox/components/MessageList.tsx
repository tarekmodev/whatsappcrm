'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import type { MessageResponse } from '@whatsappcrm/contracts';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { Notice } from '@/components/ui/Notice';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useContent } from '@/lib/content';
import { THREAD_SKELETON_COUNT } from '@/features/inbox/constants';
import { groupMessagesByDay } from '@/features/inbox/message-days';
import { groupMessagesIntoRuns, senderOf } from '@/features/inbox/message-runs';
import { useStickToBottom } from '@/features/inbox/useStickToBottom';
import { MessageRun, MessageRunSkeleton } from './MessageRun';
import { useSenderName } from './useSenderName';
import styles from './MessageList.module.css';

/**
 * The thread. Usage:
 * `<MessageList messages={…} contactName={…} senderNames={…} hasOlderMessages={…} />`.
 *
 * A scroll container rather than a growing page, so the composer stays where an
 * agent left it, and **bottom-anchored**: a short conversation sits on the
 * composer instead of at the top of a column with several hundred pixels of
 * nothing under it (TAR-518). The container is a `log` with a tab stop — a
 * scrollable box keyboard users cannot reach is a box they cannot read.
 *
 * ## One announcement per message, not one per render
 *
 * `role="log"` names the region for what it is, and its live behaviour is
 * explicitly **off**: React re-renders the list on every refetch, and a live
 * `<ol>` announces whatever moved — which on a thread grouped into runs is the
 * whole of the last run, every time. The announcement is a separate polite region
 * carrying exactly one sentence, "sender: text", built from the newest message
 * and skipped on first render, because a thread that has just loaded is not news.
 */

export interface MessageListProps {
  /** Oldest first — reading order, and the order `thread.data.ts` returns. */
  messages: readonly MessageResponse[];
  /** The conversation's contact: the sender of every inbound run. */
  contactName: string;
  senderNames: ReadonlyMap<string, string>;
  hasOlderMessages: boolean;
}

export function MessageList({
  messages,
  contactName,
  senderNames,
  hasOlderMessages,
}: MessageListProps) {
  const content = useContent();
  const newest = messages.at(-1) ?? null;
  const { scrollerRef, missedCount, jumpToLatest } = useStickToBottom(
    newest?.id ?? null,
    messages.length,
  );

  if (messages.length === 0) {
    return (
      <div className={styles.emptyState}>
        <EmptyState
          icon="conversation"
          title={content.thread.emptyHeading}
          description={content.thread.emptyBody}
        />
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      {hasOlderMessages ? (
        // Said rather than implied: an agent scrolling to the top of a page and
        // finding no more must know whether that is the start of the
        // conversation or the start of what was fetched. Paging further back is
        // a follow-up, and this is what makes its absence visible.
        <Notice tone="info" variant="quiet">
          {content.thread.olderMessagesNotice(messages.length)}
        </Notice>
      ) : null}

      <div className={styles.stream}>
        <div
          ref={scrollerRef}
          className={styles.scroller}
          role="log"
          // Deliberate: the announcer below is this region's voice. Two live
          // regions over one list is how a screen reader reads a thread twice.
          aria-live="off"
          aria-label={content.thread.messagesHeading}
          tabIndex={0}
        >
          <ol className={styles.list}>
            {groupMessagesByDay(messages).map((day) => (
              <Fragment key={day.key}>
                {/* A chip between days, in the list rather than around it: a
                    wrapper per day would break the single `<ol>` that makes the
                    thread one enumerable sequence to a screen reader. */}
                <li className={styles.divider}>
                  <time className={styles.dividerLabel} dateTime={day.isoTimestamp}>
                    <VisuallyHidden>{content.thread.dayLabel(day.label)}</VisuallyHidden>
                    <span aria-hidden="true">{day.label}</span>
                  </time>
                </li>
                {groupMessagesIntoRuns(day.messages).map((run) => (
                  <MessageRun
                    key={run.key}
                    run={run}
                    contactName={contactName}
                    senderNames={senderNames}
                  />
                ))}
              </Fragment>
            ))}
          </ol>
        </div>

        <NewMessagesPill count={missedCount} onJump={jumpToLatest} />
      </div>

      <NewestMessageAnnouncement
        message={newest}
        contactName={contactName}
        senderNames={senderNames}
      />
    </div>
  );
}

/**
 * "3 new messages ↓", over the foot of the stream, offered instead of yanking
 * the viewport. Rendered only while there is something to catch up on, so it is
 * never a control that does nothing.
 */
function NewMessagesPill({ count, onJump }: { count: number; onJump: () => void }) {
  const content = useContent();

  if (count === 0) {
    return null;
  }

  return (
    <button type="button" className={styles.pill} onClick={onJump}>
      {content.thread.newMessages(count)}
      <Icon name="chevronDown" size="sm" />
      <VisuallyHidden>{content.thread.jumpToLatest}</VisuallyHidden>
    </button>
  );
}

/**
 * The stream's voice: one polite sentence naming who sent the newest message and
 * what it says.
 *
 * The first newest id is *recorded rather than announced* — the thread arriving
 * is the page loading, not a message coming in — and every change after that is
 * one announcement. An empty body (a photo, a location) announces the message's
 * kind, because "Fatima Al-Zahra:" followed by silence tells a screen-reader user
 * nothing arrived.
 */
function NewestMessageAnnouncement({
  message,
  contactName,
  senderNames,
}: {
  message: MessageResponse | null;
  contactName: string;
  senderNames: ReadonlyMap<string, string>;
}) {
  const content = useContent();
  const nameOf = useSenderName();
  const [announcement, setAnnouncement] = useState('');
  const seenRef = useRef<string | null>(null);

  useEffect(() => {
    if (message === null || seenRef.current === message.id) {
      return;
    }

    const isFirst = seenRef.current === null;

    seenRef.current = message.id;

    if (isFirst) {
      return;
    }

    const name = nameOf(senderOf(message), contactName, senderNames);
    const body = message.body?.trim() ?? '';

    setAnnouncement(
      content.thread.messageArrived(name, body === '' ? content.messageTypes[message.type] : body),
    );
  }, [message, contactName, senderNames, content, nameOf]);

  return (
    <VisuallyHidden as="p">
      <span role="status">{announcement}</span>
    </VisuallyHidden>
  );
}

/**
 * Mirrors `MessageList`: the same scroll container at the same height, the same
 * bottom-anchored list, and alternating run skeletons with the same avatar
 * gutter and label line — so the swap to real messages moves nothing.
 */
export function MessageListSkeleton() {
  const content = useContent();

  return (
    <div className={styles.wrapper}>
      <LoadingAnnouncement label={content.thread.loading} />
      <div className={styles.stream}>
        <div className={styles.scroller}>
          <ol className={styles.list} aria-hidden="true">
            {Array.from({ length: THREAD_SKELETON_COUNT }, (_unused, index) => (
              <MessageRunSkeleton key={index} index={index} />
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
