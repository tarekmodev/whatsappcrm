'use client';

import type { MessageResponse } from '@whatsappcrm/contracts';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useContent } from '@/lib/content';
import { MessageAttachmentView } from './MessageAttachment';
import styles from './MessageBubble.module.css';

/**
 * One message in the thread. Usage:
 * `<MessageBubble message={…} senderName={…} />`.
 *
 * Direction decides the side and the tone, and it is expressed as a data
 * attribute the module file reads rather than as a second class name — so a
 * theme swap or forced-colors mode changes the token, not this component.
 *
 * Every message renders *something*. Text and the media kinds render their own
 * content; a location, a shared contact or a type Meta invented after this was
 * written render a labelled placeholder, because a customer who sent their
 * location deserves a row saying so rather than a gap in the conversation.
 */

export interface MessageBubbleProps {
  message: MessageResponse;
  /** Resolved display name for `sentByUserId`; `null` for inbound or automation. */
  senderName: string | null;
}

export function MessageBubble({ message, senderName }: MessageBubbleProps) {
  const content = useContent();
  const body = message.body?.trim() ?? '';
  const hasAttachments = message.attachments.length > 0;

  return (
    <li className={styles.row} data-direction={message.direction}>
      <article className={styles.bubble} data-direction={message.direction}>
        {/* The direction is carried in text, not only in the alignment and the
            colour: a screen reader has neither. */}
        <VisuallyHidden>
          {message.direction === 'inbound' ? content.thread.inbound : content.thread.outbound}
        </VisuallyHidden>

        {hasAttachments ? (
          <div className={styles.attachments}>
            {message.attachments.map((attachment) => (
              <MessageAttachmentView
                key={attachment.id}
                attachment={attachment}
                direction={message.direction}
              />
            ))}
          </div>
        ) : null}

        {body === '' ? null : <p className={styles.body}>{body}</p>}

        {body === '' && !hasAttachments ? (
          <p className={styles.placeholder}>
            <span className={styles.placeholderKind}>{content.messageTypes[message.type]}</span>
            {content.thread.unrenderableBody}
          </p>
        ) : null}

        <MessageMeta message={message} senderName={senderName} />
      </article>
    </li>
  );
}

function MessageMeta({ message, senderName }: MessageBubbleProps) {
  const content = useContent();

  return (
    <p className={styles.meta}>
      {message.direction === 'outbound' ? (
        <OutboundAuthor message={message} senderName={senderName} />
      ) : null}
      <RelativeTime isoTimestamp={message.sentAt} label={content.thread.sentAt} />
      {message.direction === 'outbound' ? (
        <span className={styles.status} data-status={message.status}>
          {content.messageStatuses[message.status]}
        </span>
      ) : null}
      {message.failureReason === null ? null : (
        <span className={styles.failure}>
          {content.thread.failureReason(message.failureReason)}
        </span>
      )}
    </p>
  );
}

/**
 * Who sent an outbound message, in the order the answers are trustworthy.
 *
 * `sentByAutomation` is the contract's answer to "was a human involved", and it
 * is asked **first** — because a missing name is not evidence of a bot. The
 * directory that resolves `sentByUserId` is one page of users, so in a tenant
 * with more than a page of them a real agent's reply resolved to no name and was
 * captioned "Sent automatically": a lie about the one thing this product is a
 * record of. An unresolved human is now said to be an unresolved human.
 */
function OutboundAuthor({ message, senderName }: MessageBubbleProps) {
  const content = useContent();

  if (message.sentByAutomation) {
    // The chatbot (TAR-28) or a workflow (TAR-27). Worth saying: an agent should
    // not have to wonder who replied on their behalf.
    return <span>{content.thread.sentByAutomation}</span>;
  }

  if (senderName !== null) {
    return <span>{content.thread.sentBy(senderName)}</span>;
  }

  return <span>{content.thread.sentByTeammate}</span>;
}

/**
 * Mirrors `MessageBubble`: the same list row, the same bubble frame, two body
 * lines and a meta line — and it alternates sides, because a thread skeleton
 * that is all one side does not read as a conversation.
 */
export function MessageBubbleSkeleton({ index }: { index: number }) {
  const direction = index % 2 === 0 ? 'inbound' : 'outbound';

  return (
    <li className={styles.row} data-direction={direction} aria-hidden="true">
      <div className={styles.bubble} data-direction={direction}>
        <SkeletonText lines={2} />
        <p className={styles.meta}>
          <SkeletonLine width="5rem" />
        </p>
      </div>
    </li>
  );
}
