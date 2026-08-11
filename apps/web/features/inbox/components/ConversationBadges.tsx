'use client';

import type { ConversationResponse } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { Cluster } from '@/components/layout/Cluster';
import { useContent } from '@/lib/content';

/**
 * Status, unread count and who holds a conversation, as one badge row. Usage:
 * `<ConversationBadges conversation={…} assigneeName={…} teamName={…} />`.
 *
 * Shared by the list row and the thread header because the two showed the
 * identical set the moment the thread view existed — and an inbox where a row
 * and the header above it disagree about who owns a conversation is worse than
 * one that says nothing.
 *
 * "Unclaimed" is a badge rather than an absence: ADR 0002 amendment 4 makes an
 * unclaimed thread visible to every agent on the tenant, which only helps if the
 * list says which ones they are.
 */

export interface ConversationBadgesProps {
  conversation: ConversationResponse;
  assigneeName: string | null;
  teamName: string | null;
  /** The list shows how much is unread; the open thread is being read right now. */
  showUnreadCount?: boolean;
}

export function ConversationBadges({
  conversation,
  assigneeName,
  teamName,
  showUnreadCount = true,
}: ConversationBadgesProps) {
  const content = useContent();
  const isUnclaimed = conversation.assignedUserId === null && conversation.assignedTeamId === null;

  return (
    <Cluster gap="2">
      <Badge tone={conversation.status === 'open' ? 'accent' : 'neutral'}>
        {content.conversationStatuses[conversation.status]}
      </Badge>

      {showUnreadCount && conversation.unreadCount > 0 ? (
        <Badge tone="info">{content.inbox.unreadCount(conversation.unreadCount)}</Badge>
      ) : null}

      {/* Keyed on the *id*, not on the name. The directory read is one page, so a
          tenant past it resolves no name — and dropping the badge for that made a
          thread somebody is holding look unheld, which is the state this row
          exists to report. */}
      {conversation.assignedUserId === null ? null : (
        <Badge>
          {assigneeName === null
            ? content.inbox.assignedToUnresolved
            : content.inbox.assignedTo(assigneeName)}
        </Badge>
      )}
      {teamName === null ? null : <Badge>{content.inbox.assignedToTeam(teamName)}</Badge>}
      {isUnclaimed ? <Badge tone="warning">{content.inbox.unclaimed}</Badge> : null}

      {conversation.botHandling ? <Badge tone="info">{content.inbox.botHandling}</Badge> : null}
    </Cluster>
  );
}
