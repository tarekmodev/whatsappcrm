'use client';

import Link from 'next/link';
import type { ConversationResponse } from '@whatsappcrm/contracts';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonCircle, SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { Cluster } from '@/components/layout/Cluster';
import { useContent } from '@/lib/content';
import { routes, type ConversationStatusFilter, type InboxScope } from '@/lib/routes';
import {
  canChangeHold,
  conversationHold,
  type HoldPermissions,
} from '@/features/inbox/conversation-hold';
import { ClaimButton } from './ClaimButton';
import { ConversationBadges } from './ConversationBadges';
import styles from './ConversationRow.module.css';
import listStyles from './ConversationList.module.css';

/**
 * One conversation in the list. Usage:
 * `<ConversationRow conversation={…} assigneeName={…} teamName={…} isSelected={…} query={…} claim={…} />`.
 *
 * A card rather than a table row: a conversation is a headline plus metadata,
 * not a set of comparable columns, and cards read the same at 320px as at
 * 1920px with no stacking rules.
 *
 * ## Two targets, one card
 *
 * The headline is a link whose hit area is stretched over the whole card, so the
 * target is far larger than the 44px minimum. The claim control is a **sibling**
 * of that link, not a child — a button inside an anchor is invalid and behaves
 * differently in every browser — lifted above the stretched area so a click on it
 * claims rather than navigates. That is what puts the claim on the list as well
 * as the thread, which is TAR-71's scope.
 */

export interface ConversationRowProps {
  conversation: ConversationResponse;
  assigneeName: string | null;
  teamName: string | null;
  isSelected: boolean;
  /** The list's current filters, carried into the link so back preserves them. */
  query: InboxListQuery;
  /**
   * Who is looking and what they may do to a hold. `null` for a principal
   * holding neither `conversation:claim` nor `conversation:assign`, who gets no
   * control on any row.
   */
  claim: ClaimContext | null;
}

export interface ClaimContext extends HoldPermissions {
  currentUserId: string;
}

/**
 * Everything about the list's current view that a link out of it has to carry
 * back: the filter, and the search that produced it. Shared by the row, the
 * list and the thread's back link so none of them can forget one.
 */
export interface InboxListQuery {
  scope: InboxScope;
  status: ConversationStatusFilter | undefined;
  q?: string;
}

export function ConversationRow({
  conversation,
  assigneeName,
  teamName,
  isSelected,
  query,
  claim,
}: ConversationRowProps) {
  const content = useContent();
  const contactName = conversation.contact.displayName;
  // `null` when there is nobody to compute it for — a principal with no claim
  // control gets no button on any row and no hold to describe.
  const hold =
    claim === null
      ? null
      : conversationHold(conversation.assignedUserId, claim.currentUserId, assigneeName);

  return (
    <li className={listStyles.row} data-selected={isSelected ? 'true' : undefined}>
      <div className={styles.card}>
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
        </Link>

        <Cluster justify="between" align="end" gap="2" className={styles.footer}>
          <ConversationBadges
            conversation={conversation}
            assigneeName={assigneeName}
            teamName={teamName}
            filter={query}
          />
          {/* Shown only for the direction this reader may actually take:
              claiming is everyone's, releasing and taking over are a
              supervisor's. */}
          {hold !== null && claim !== null && canChangeHold(hold, claim) ? (
            <div className={styles.action}>
              <ClaimButton
                conversationId={conversation.id}
                contactName={contactName}
                hold={hold}
                size="sm"
              />
            </div>
          ) : null}
        </Cluster>
      </div>
    </li>
  );
}

/**
 * Mirrors `ConversationRow`: the same card frame and the same three rows —
 * headline, preview, badge row — so nothing shifts when the data lands.
 *
 * The badge row reserves what a row now carries at most: one status chip and the
 * holder's avatar. It is a circle rather than a third line because that is what
 * lands there — a skeleton drawn as pills for a row that renders an avatar is
 * exactly the drift 0001 forbids.
 *
 * `hasClaim` keeps the badge row the same height for a principal who will get a
 * claim button, since a `sm` button is taller than a badge.
 */
export function ConversationRowSkeleton({ hasClaim = false }: { hasClaim?: boolean }) {
  return (
    <li className={listStyles.row}>
      <div className={styles.card}>
        <div className={styles.link}>
          <Cluster justify="between" align="start" gap="2">
            <SkeletonLine width="10rem" />
            <SkeletonLine width="5rem" />
          </Cluster>
          <SkeletonText lines={1} />
        </div>
        <Cluster justify="between" align="end" gap="2" className={styles.footer}>
          <Cluster gap="2">
            <SkeletonLine width="5rem" height="1.25rem" />
            <SkeletonCircle size="var(--size-control-sm)" />
          </Cluster>
          {hasClaim ? <SkeletonLine width="4.5rem" height="var(--size-control-sm)" /> : null}
        </Cluster>
      </div>
    </li>
  );
}
