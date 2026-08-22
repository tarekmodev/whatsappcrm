'use client';

import Link from 'next/link';
import type { ConversationResponse, ConversationSort } from '@whatsappcrm/contracts';
import { Avatar } from '@/components/ui/Avatar';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonCircle, SkeletonLine } from '@/components/ui/Skeleton';
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
import type { ThreadEmphasis } from '@/features/inbox/thread-state';
import { ClaimButton } from './ClaimButton';
import { ConversationBadges } from './ConversationBadges';
import { TakeFromBotButton } from './TakeFromBotButton';
import { ThreadActions } from './ThreadActions';
import styles from './ThreadHeader.module.css';

/**
 * Who the open conversation is with, who holds it, and the controls that change
 * that. Usage:
 * `<ThreadHeader conversation={…} assigneeName={…} teamName={…} holdPermissions={…} currentUserId={…} query={…} emphasis={…} isUnclaimed={…} />`.
 *
 * ## Two rows, and exactly one solid button
 *
 * Row one is the identity — a face, a name, a number — with the action cluster
 * opposite it. Row two is at most two status chips plus who holds the thread,
 * said in words rather than as a mark with a tooltip.
 *
 * Only the action named by `emphasis` is drawn solid. Before TAR-518 this header
 * could render `Take over from the bot` and `Claim` side by side, both solid
 * accent, above a full-width saturated notice repeating what one of them was
 * for — three loud things about one decision. `thread-state.ts` decides which
 * one it is, and the composer says the *why* in one quiet line where the reply
 * was going to be typed. The header says nothing at all now.
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
  /** The order the list was in, so the back link returns to that too. */
  sort: ConversationSort;
}

export interface ThreadHeaderProps {
  conversation: ConversationResponse;
  assigneeName: string | null;
  teamName: string | null;
  /** `conversation:claim` and `conversation:assign` — see `canChangeHold`. */
  holdPermissions: HoldPermissions;
  currentUserId: string;
  query: ThreadQuery;
  /** Which control is this screen's one solid accent button — see `threadState`. */
  emphasis: ThreadEmphasis;
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
  emphasis,
  isUnclaimed,
}: ThreadHeaderProps) {
  const content = useContent();
  const hold = conversationHold(conversation.assignedUserId, currentUserId, assigneeName);

  return (
    <Stack gap="3">
      <BackToList query={query} />

      <Cluster justify="between" align="start" gap="3">
        <Cluster gap="3" align="center" className={styles.identity}>
          {/* Decorative by construction: the name is beside it. */}
          <Avatar name={conversation.contact.displayName} size="sm" tone="neutral" />
          <div className={styles.names}>
            <h3 className={styles.name}>{conversation.contact.displayName}</h3>
            {/* `dir="ltr"`: a phone number reads left to right whatever the
                surrounding text direction is. */}
            <p className={styles.phone} dir="ltr">
              {conversation.contact.phone}
            </p>
          </div>
        </Cluster>

        <Cluster gap="2" align="start" className={styles.controls}>
          {/* Offered only while the chatbot actually holds the reply. A thread
              already handed over needs no button — the bot has stopped — and
              the endpoint would answer `200` and write nothing anyway. */}
          {canRequestHandoff(conversation.botState) && holdPermissions.canClaim ? (
            <TakeFromBotButton
              conversationId={conversation.id}
              contactName={conversation.contact.displayName}
              emphasis={emphasis === 'handoff' ? 'accent' : 'quiet'}
            />
          ) : null}
          {canChangeHold(hold, holdPermissions) ? (
            <ClaimButton
              conversationId={conversation.id}
              contactName={conversation.contact.displayName}
              hold={hold}
              emphasis={emphasis === 'claim' ? 'accent' : 'quiet'}
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

      <Cluster gap="3" align="center" className={styles.meta}>
        <ConversationBadges
          conversation={conversation}
          assigneeName={assigneeName}
          teamName={teamName}
          filter={query}
          view="detail"
        />
        <p className={styles.created}>
          <RelativeTime isoTimestamp={conversation.createdAt} label={content.inbox.createdAt} />
        </p>
      </Cluster>
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
 * Mirrors `ThreadHeader`: the same back link, the same avatar beside two identity
 * lines, and the same metadata row — so the swap to a real conversation moves
 * nothing.
 */
export function ThreadHeaderSkeleton({ query }: { query: ThreadQuery }) {
  return (
    <Stack gap="3">
      <BackToList query={query} />
      <Cluster justify="between" align="start" gap="3" aria-hidden="true">
        <Cluster gap="3" align="center" className={styles.identity}>
          <SkeletonCircle size="var(--size-control-sm)" />
          <div className={styles.names}>
            <SkeletonLine width="12rem" height="var(--font-size-heading-sm)" />
            <SkeletonLine width="8rem" />
          </div>
        </Cluster>
        {/* Reserves the height of the action cluster, so its controls arriving
            does not move the metadata row below. */}
        <SkeletonLine width="10rem" height="var(--size-touch-target)" />
      </Cluster>
      {/* Two chips, the holder's name and the created time: the most a detail
          header now carries. */}
      <Cluster gap="3" aria-hidden="true">
        <SkeletonLine width="6rem" height="1.75rem" />
        <SkeletonLine width="5rem" height="1.75rem" />
        <SkeletonLine width="7rem" />
      </Cluster>
    </Stack>
  );
}
