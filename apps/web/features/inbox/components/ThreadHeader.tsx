'use client';

import Link from 'next/link';
import type { ConversationResponse } from '@whatsappcrm/contracts';
import { Notice } from '@/components/ui/Notice';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { routes, type ConversationStatusFilter, type InboxScope } from '@/lib/routes';
import {
  canChangeHold,
  conversationHold,
  type HoldPermissions,
} from '@/features/inbox/conversation-hold';
import { ClaimButton } from './ClaimButton';
import { ConversationBadges } from './ConversationBadges';
import styles from './ThreadHeader.module.css';

/**
 * Who the open conversation is with, who holds it, and the one control that
 * changes that. Usage:
 * `<ThreadHeader conversation={…} assigneeName={…} teamName={…} holdPermissions={…} currentUserId={…} query={…} />`.
 *
 * The back link is the small-screen half of the two-pane layout: at narrow
 * widths the thread replaces the list, so there has to be a way back that is not
 * the browser's own button. It is a real link to the list URL — with the filters
 * intact — rather than a history step, so it works on a deep link too, and it is
 * hidden once both panes fit on screen.
 */

export interface ThreadQuery {
  scope: InboxScope;
  status: ConversationStatusFilter | undefined;
}

export interface ThreadHeaderProps {
  conversation: ConversationResponse;
  assigneeName: string | null;
  teamName: string | null;
  /** `conversation:claim` and `conversation:assign` — see `canChangeHold`. */
  holdPermissions: HoldPermissions;
  currentUserId: string;
  query: ThreadQuery;
}

export function ThreadHeader({
  conversation,
  assigneeName,
  teamName,
  holdPermissions,
  currentUserId,
  query,
}: ThreadHeaderProps) {
  const content = useContent();
  const hold = conversationHold(conversation.assignedUserId, currentUserId, assigneeName);

  return (
    <Stack gap="3">
      <BackToList query={query} />

      <Cluster justify="between" align="start" gap="3">
        <div className={styles.identity}>
          <h3 className={styles.name}>{conversation.contact.displayName}</h3>
          {/* `dir="ltr"`: a phone number reads left to right whatever the
              surrounding text direction is. */}
          <p className={styles.phone} dir="ltr">
            {conversation.contact.phone}
          </p>
        </div>

        {canChangeHold(hold, holdPermissions) ? (
          <ClaimButton
            conversationId={conversation.id}
            contactName={conversation.contact.displayName}
            hold={hold}
          />
        ) : null}
      </Cluster>

      <ConversationBadges
        conversation={conversation}
        assigneeName={assigneeName}
        teamName={teamName}
        showUnreadCount={false}
      />

      {hold.state === 'unclaimed' && !holdPermissions.canClaim ? (
        // Said rather than left as a missing button: a console that simply
        // showed nothing here would read as a broken screen. Rare since TAR-186
        // gave every role `conversation:claim`.
        <Notice tone="info">{content.inbox.claimNotPermitted}</Notice>
      ) : null}
    </Stack>
  );
}

function BackToList({ query }: { query: ThreadQuery }) {
  const content = useContent();

  return (
    <Link className={styles.back} href={routes.inbox(query)} scroll={false}>
      {content.inbox.backToList}
    </Link>
  );
}

/**
 * Mirrors `ThreadHeader`: the same back link, the same two identity lines and
 * the same badge row, so the swap to a real conversation moves nothing.
 */
export function ThreadHeaderSkeleton({ query }: { query: ThreadQuery }) {
  return (
    <Stack gap="3">
      <BackToList query={query} />
      <div className={styles.identity} aria-hidden="true">
        <SkeletonLine width="12rem" height="var(--font-size-heading-sm)" />
        <SkeletonLine width="8rem" />
      </div>
      <Cluster gap="2" aria-hidden="true">
        <SkeletonLine width="4rem" height="1.25rem" />
        <SkeletonLine width="6rem" height="1.25rem" />
      </Cluster>
    </Stack>
  );
}
