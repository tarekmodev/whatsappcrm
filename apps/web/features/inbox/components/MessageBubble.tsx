'use client';

import type { MessageResponse } from '@whatsappcrm/contracts';
import { SkeletonText } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { hasDeliveryState } from '@/features/inbox/delivery-state';
import { MessageAttachmentView } from './MessageAttachment';
import { MessageDelivery } from './MessageDelivery';
import styles from './MessageBubble.module.css';

/**
 * One message in the thread. Usage:
 * `<MessageBubble message={…} contactName={…} />`, inside a `MessageRun`.
 *
 * Direction decides the side and the tone, and it is expressed as a data
 * attribute the module file reads rather than as a second class name — so a
 * theme swap or forced-colors mode changes the token, not this component.
 *
 * Every message renders *something*. Text and the media kinds render their own
 * content; a location, a shared contact or a type Meta invented after this was
 * written render a labelled placeholder, because a customer who sent their
 * location deserves a row saying so rather than a gap in the conversation.
 *
 * ## What this no longer carries
 *
 * Who sent it, when, and over which channel used to be a meta line **inside
 * every bubble**. They are the run's now (`MessageRun`): four consecutive
 * messages from one customer repeated their name and the time four times, which
 * is what made a thread read as a message table rather than a conversation. What
 * stays here is what is genuinely per-message — the content, and whether that
 * particular message reached the customer.
 */

export interface MessageBubbleProps {
  message: MessageResponse;
  /** Named in the retry's accessible name on a failed message. */
  contactName: string;
}

export function MessageBubble({ message, contactName }: MessageBubbleProps) {
  const content = useContent();
  const body = message.body?.trim() ?? '';
  const hasAttachments = message.attachments.length > 0;

  return (
    <li className={styles.row}>
      <article className={styles.bubble} data-direction={message.direction}>
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

        {hasDeliveryState(message) ? (
          <MessageDelivery message={message} contactName={contactName} />
        ) : null}
      </article>
    </li>
  );
}

/**
 * Mirrors `MessageBubble`: the same list row, the same bubble frame and two body
 * lines. The sender label and the avatar belong to the run above it, so
 * `MessageRunSkeleton` stands in for those — this is only the box.
 */
export function MessageBubbleSkeleton({ direction }: { direction: 'inbound' | 'outbound' }) {
  return (
    <li className={styles.row} aria-hidden="true">
      <div className={styles.bubble} data-direction={direction}>
        <SkeletonText lines={2} />
      </div>
    </li>
  );
}
