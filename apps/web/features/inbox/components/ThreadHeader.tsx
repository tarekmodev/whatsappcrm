'use client';

import Link from 'next/link';
import type { ConversationResponse } from '@whatsappcrm/contracts';
import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { routes, type ConversationStatusFilter, type InboxScope } from '@/lib/routes';
import { canRequestHandoff } from '@/features/inbox/bot-state';
import {
  canChangeHold,
  conversationHold,
  type HoldPermissions,
} from '@/features/inbox/conversation-hold';
import { ClaimButton } from './ClaimButton';
import { ConversationBadges } from './ConversationBadges';
import { TakeFromBotButton } from './TakeFromBotButton';
import { ThreadActions } from './ThreadActions';
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
  /** The search that produced the list, so the back link returns to it. */
  q?: string;
}

export interface ThreadHeaderProps {
  conversation: ConversationResponse;
  assigneeName: string | null;
  teamName: string | null;
  /** `conversation:claim` and `conversation:assign` — see `canChangeHold`. */
  holdPermissions: HoldPermissions;
  currentUserId: string;
  query: ThreadQuery;
  /** Nobody holds this thread; the status control is not offered on one. */
  isUnclaimed: boolean;
}

export function ThreadHeader({
  conversation,
  assigneeName,
  teamName,
  holdPermissions,
  currentUserId,
  query,
  isUnclaimed,
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
          <p className={styles.created}>
            <RelativeTime isoTimestamp={conversation.createdAt} label={content.inbox.createdAt} />
          </p>
        </div>

        <Cluster gap="2" align="start" className={styles.controls}>
          {/* Offered only while the chatbot actually holds the reply. A thread
              already handed over needs no button — the bot has stopped — and
              the endpoint would answer `200` and write nothing anyway. */}
          {canRequestHandoff(conversation.botState) && holdPermissions.canClaim ? (
            <TakeFromBotButton
              conversationId={conversation.id}
              contactName={conversation.contact.displayName}
            />
          ) : null}
          {canChangeHold(hold, holdPermissions) ? (
            <ClaimButton
              conversationId={conversation.id}
              contactName={conversation.contact.displayName}
              hold={hold}
            />
          ) : null}
          <ThreadActions
            conversationId={conversation.id}
            contactName={conversation.contact.displayName}
            status={conversation.status}
            isUnclaimed={isUnclaimed}
          />
        </Cluster>
      </Cluster>

      <ConversationBadges
        conversation={conversation}
        assigneeName={assigneeName}
        teamName={teamName}
        showUnreadCount={false}
      />

      {/* Why nobody on the team has replied. Without it, a thread the chatbot
          is answering reads as one everybody is ignoring. */}
      {canRequestHandoff(conversation.botState) ? (
        <Notice tone="info">{content.inbox.botActiveNotice}</Notice>
      ) : null}

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
      <Cluster justify="between" align="start" gap="3" aria-hidden="true">
        <div className={styles.identity}>
          <SkeletonLine width="12rem" height="var(--font-size-heading-sm)" />
          <SkeletonLine width="8rem" />
          <SkeletonLine width="6rem" />
        </div>
        {/* Reserves the height of the status button and the details toggle, so
            neither appearing moves the badge row below. */}
        <SkeletonLine width="10rem" height="var(--size-touch-target)" />
      </Cluster>
      <Cluster gap="2" aria-hidden="true">
        <SkeletonLine width="4rem" height="1.25rem" />
        <SkeletonLine width="6rem" height="1.25rem" />
      </Cluster>
    </Stack>
  );
}
