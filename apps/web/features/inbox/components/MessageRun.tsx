'use client';

import { Avatar } from '@/components/ui/Avatar';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonCircle, SkeletonLine } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useContent } from '@/lib/content';
import type { MessageRun as MessageRunModel } from '@/features/inbox/message-runs';
import { MessageBubble, MessageBubbleSkeleton } from './MessageBubble';
import { useSenderName } from './useSenderName';
import styles from './MessageRun.module.css';

/**
 * A run of consecutive messages from one sender: one avatar, one label line, and
 * the bubbles under it. Usage:
 * `<MessageRun run={run} contactName={…} senderNames={…} />`, from `MessageList`.
 *
 * This is the component that makes a busy thread readable. Before it, every
 * bubble carried its own sender, timestamp and channel tag, so a customer who
 * sent four lines in twenty seconds produced four identical captions — a message
 * table with rounded corners. `message-runs.ts` decides where a run starts and
 * ends; this only draws one.
 *
 * ## Direction is in the text, not only in the side
 *
 * Which way a message went is carried by the side and the tint for a sighted
 * reader and by neither for a screen reader, so the label line opens with a
 * visually hidden "From the customer" / "From your team". It is on the run
 * rather than on each bubble for the same reason the name is: said once per
 * utterance is information, said once per line is noise.
 */

export interface MessageRunProps {
  run: MessageRunModel;
  /** The conversation's contact — the sender of every inbound run. */
  contactName: string;
  /** The directory behind `sentByUserId`; a large tenant has agents beyond it. */
  senderNames: ReadonlyMap<string, string>;
}

export function MessageRun({ run, contactName, senderNames }: MessageRunProps) {
  const content = useContent();
  const nameOf = useSenderName();
  const first = run.messages[0];
  const direction = first?.direction ?? 'inbound';
  const senderName = nameOf(run.sender, contactName, senderNames);

  return (
    <li className={styles.run} data-direction={direction}>
      {/* Decorative by construction: the name is in the label line beside it. */}
      <Avatar
        name={senderName}
        size="sm"
        tone={direction === 'inbound' ? 'neutral' : 'accent'}
        className={styles.avatar}
      />

      <div className={styles.body}>
        <p className={styles.label}>
          <VisuallyHidden>
            {direction === 'inbound' ? content.thread.inbound : content.thread.outbound}
          </VisuallyHidden>
          <span className={styles.sender}>{senderName}</span>
          <RelativeTime isoTimestamp={run.isoTimestamp} label={content.thread.sentAt} />
          {/* Which channel this travelled over. One channel exists today, so it
              is always the same word — it is here because the day a second one
              lands, a thread that never said "WhatsApp" becomes ambiguous
              retrospectively, and this is the line that would have to change. */}
          <span className={styles.channel}>{content.channels.whatsapp}</span>
        </p>

        <ol className={styles.bubbles}>
          {run.messages.map((message) => (
            <MessageBubble key={message.id} message={message} contactName={contactName} />
          ))}
        </ol>
      </div>
    </li>
  );
}

/**
 * Mirrors `MessageRun`: the same avatar gutter, the same label line and the same
 * bubble stack — and it alternates sides, because a thread skeleton that is all
 * one side does not read as a conversation.
 */
export function MessageRunSkeleton({ index }: { index: number }) {
  const direction = index % 2 === 0 ? 'inbound' : 'outbound';

  return (
    <li className={styles.run} data-direction={direction} aria-hidden="true">
      <SkeletonCircle size="var(--size-control-sm)" />
      <div className={styles.body}>
        <p className={styles.label}>
          <SkeletonLine width="7rem" />
          <SkeletonLine width="4rem" />
        </p>
        <ol className={styles.bubbles}>
          <MessageBubbleSkeleton direction={direction} />
        </ol>
      </div>
    </li>
  );
}
