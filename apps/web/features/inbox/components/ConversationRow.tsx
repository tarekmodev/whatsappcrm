'use client';

import Link from 'next/link';
import type { ConversationResponse } from '@whatsappcrm/contracts';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { Cluster } from '@/components/layout/Cluster';
import { useContent } from '@/lib/content';
import { routes, type ConversationStatusFilter, type InboxScope } from '@/lib/routes';
import { ConversationBadges } from './ConversationBadges';
import styles from './ConversationRow.module.css';
import listStyles from './ConversationList.module.css';

/**
 * One conversation in the list. Usage:
 * `<ConversationRow conversation={…} assigneeName={…} teamName={…} isSelected={…} query={…} />`.
 *
 * A card rather than a table row: a conversation is a headline plus metadata,
 * not a set of comparable columns, and cards read the same at 320px as at
 * 1920px with no stacking rules.
 *
 * The whole card is one link, so the target is far larger than the 44px minimum
 * and there is exactly one tab stop per conversation. It carries the current
 * scope and status forward, so opening a thread from a filtered list and then
 * going back returns to that same filtered list.
 */

export interface ConversationRowProps {
  conversation: ConversationResponse;
  assigneeName: string | null;
  teamName: string | null;
  isSelected: boolean;
  /** The list's current filters, carried into the link so back preserves them. */
  query: { scope: InboxScope; status: ConversationStatusFilter | undefined };
}

export function ConversationRow({
  conversation,
  assigneeName,
  teamName,
  isSelected,
  query,
}: ConversationRowProps) {
  const content = useContent();
  const contactName = conversation.contact.displayName;

  return (
    <li className={listStyles.row} data-selected={isSelected ? 'true' : undefined}>
      <Link
        className={styles.link}
        href={routes.inbox({ ...query, conversationId: conversation.id })}
        // Says which conversation without the reader having to infer it from the
        // card's contents, and marks the open one for assistive technology.
        aria-label={content.inbox.openConversation(contactName)}
        aria-current={isSelected ? 'true' : undefined}
        scroll={false}
      >
        <Cluster justify="between" align="start" gap="2">
          <p className={styles.contact}>{contactName}</p>
          <RelativeTime
            isoTimestamp={conversation.lastMessageAt}
            label={content.inbox.lastActivity}
          />
        </Cluster>

        <p className={styles.preview}>{conversation.lastMessagePreview ?? ''}</p>

        <ConversationBadges
          conversation={conversation}
          assigneeName={assigneeName}
          teamName={teamName}
        />
      </Link>
    </li>
  );
}

/**
 * Mirrors `ConversationRow`: the same card frame and the same three rows —
 * headline, preview, badge row — so nothing shifts when the data lands.
 */
export function ConversationRowSkeleton() {
  return (
    <li className={listStyles.row}>
      <div className={styles.link}>
        <Cluster justify="between" align="start" gap="2">
          <SkeletonLine width="10rem" />
          <SkeletonLine width="5rem" />
        </Cluster>
        <SkeletonText lines={1} />
        <Cluster gap="2">
          <SkeletonLine width="4rem" height="1.25rem" />
          <SkeletonLine width="6rem" height="1.25rem" />
        </Cluster>
      </div>
    </li>
  );
}
