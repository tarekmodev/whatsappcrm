'use client';

import type { ConversationResponse } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { Cluster } from '@/components/layout/Cluster';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useContent } from '@/lib/content';
import { CONVERSATIONS_PAGE_SIZE } from '@/features/people/constants';
import styles from './ConversationList.module.css';

/**
 * The conversation list. Usage:
 * `<ConversationList conversations={…} assigneeNames={…} teamNames={…} isAllScope={…} />`.
 *
 * A list of cards rather than a table: a conversation row is a headline plus
 * metadata, not a set of comparable columns, and cards read the same at 320px as at
 * 1920px with no stacking rules.
 */

export interface ConversationListProps {
  conversations: readonly ConversationResponse[];
  assigneeNames: ReadonlyMap<string, string>;
  teamNames: ReadonlyMap<string, string>;
  /** Changes the empty-state copy: "nothing assigned to you" reads differently. */
  isAllScope: boolean;
}

export function ConversationList({
  conversations,
  assigneeNames,
  teamNames,
  isAllScope,
}: ConversationListProps) {
  const content = useContent();

  if (conversations.length === 0) {
    return (
      <EmptyState
        heading={content.inbox.emptyHeading}
        body={isAllScope ? content.inbox.emptyAllBody : content.inbox.emptyBody}
      />
    );
  }

  return (
    <ul className={styles.list}>
      {conversations.map((conversation) => (
        <ConversationRow
          key={conversation.id}
          conversation={conversation}
          assigneeName={
            conversation.assignedUserId === null
              ? null
              : (assigneeNames.get(conversation.assignedUserId) ?? null)
          }
          teamName={
            conversation.assignedTeamId === null
              ? null
              : (teamNames.get(conversation.assignedTeamId) ?? null)
          }
        />
      ))}
    </ul>
  );
}

function ConversationRow({
  conversation,
  assigneeName,
  teamName,
}: {
  conversation: ConversationResponse;
  assigneeName: string | null;
  teamName: string | null;
}) {
  const content = useContent();

  return (
    <li className={styles.row}>
      <Cluster justify="between" align="start" gap="2">
        <p className={styles.contact}>{conversation.contact.displayName}</p>
        <RelativeTime
          isoTimestamp={conversation.lastMessageAt ?? conversation.createdAt}
          label={content.inbox.lastActivity}
        />
      </Cluster>

      <p className={styles.preview}>{conversation.lastMessagePreview ?? ''}</p>

      <Cluster gap="2">
        <Badge tone={conversation.status === 'open' ? 'accent' : 'neutral'}>
          {content.conversationStatuses[conversation.status]}
        </Badge>
        {conversation.unreadCount > 0 ? (
          <Badge tone="info">{content.inbox.unreadCount(conversation.unreadCount)}</Badge>
        ) : null}
        {assigneeName === null ? null : <Badge>{content.inbox.assignedTo(assigneeName)}</Badge>}
        {teamName === null ? null : <Badge>{content.inbox.assignedToTeam(teamName)}</Badge>}
        {assigneeName === null && teamName === null ? (
          <Badge tone="warning">{content.common.unassigned}</Badge>
        ) : null}
      </Cluster>
    </li>
  );
}

/**
 * Mirrors `ConversationRow`: the same list, the same card frame, the same three
 * rows — headline, preview, badge row — so nothing shifts when the data lands.
 */
export function ConversationListSkeleton() {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.inbox.loadingConversations} />
      <ul className={styles.list} aria-hidden="true">
        {Array.from({ length: CONVERSATIONS_PAGE_SIZE }, (_unused, index) => (
          <li key={index} className={styles.row}>
            <Cluster justify="between" align="start" gap="2">
              <SkeletonLine width="10rem" />
              <SkeletonLine width="5rem" />
            </Cluster>
            <SkeletonText lines={1} />
            <Cluster gap="2">
              <SkeletonLine width="4rem" height="1.25rem" />
              <SkeletonLine width="6rem" height="1.25rem" />
            </Cluster>
          </li>
        ))}
      </ul>
    </>
  );
}
