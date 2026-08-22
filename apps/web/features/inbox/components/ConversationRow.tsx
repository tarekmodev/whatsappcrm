'use client';

import Link from 'next/link';
import type { ConversationResponse, ConversationSort } from '@whatsappcrm/contracts';
import { Avatar } from '@/components/ui/Avatar';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonCircle, SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { routes, type ConversationStatusFilter, type InboxScope } from '@/lib/routes';
import {
  canChangeHold,
  conversationHold,
  type HoldPermissions,
} from '@/features/inbox/conversation-hold';
import {
  CHIP_LIMIT,
  conversationChips,
  conversationRowName,
} from '@/features/inbox/conversation-chips';
import { ClaimButton } from './ClaimButton';
import { ConversationBadges } from './ConversationBadges';
import styles from './ConversationRow.module.css';
import listStyles from './ConversationList.module.css';

/**
 * One conversation in the list. Usage:
 * `<ConversationRow conversation={…} assigneeName={…} teamName={…} isSelected={…} query={…} claim={…} />`.
 *
 * A **queue row**, not a card (TAR-517). It was a 220px bordered card carrying
 * five pills and a solid `Claim` button, then a 142px one; three of them filled
 * the column, which made a list an agent is meant to *scan* into a stack they
 * had to read. It is now `--size-row-list` — an avatar beside two lines of
 * text — so a laptop-height column shows a dozen.
 *
 * ## An avatar and two lines
 *
 * 1. **Leading** — the contact's `Avatar`. A fixed gutter, because the hairline
 *    between rows starts where it ends; `ConversationList.module.css` owns both
 *    numbers so they cannot drift apart.
 * 2. **Line one** — the contact's name, and the timestamp at its end.
 * 3. **Line two** — one line of message preview, and the row's marks at its end:
 *    at most one status chip, the unread count, and who holds it.
 *
 * Both text cells truncate with an ellipsis rather than wrapping. A row whose
 * height depends on how much the customer typed is not a row.
 *
 * The marks share line two with the preview rather than sitting under the
 * timestamp in a column of their own, and that is arithmetic rather than taste:
 * a `Badge` is taller than a line of `body-sm`, so stacking the two put the row
 * at 74px, and 74px is eleven rows in a laptop-height column where 64px is
 * thirteen.
 *
 * ## Why the action is not in the resting row
 *
 * A solid `Claim` on every row outnumbered the screen's actual primary action
 * and was most of the row's height. It now appears at the row's end on hover
 * **and on `:focus-within`**, as a `secondary` button — so a keyboard user tabs
 * into the row's link and the action is the next tab stop, with no pointer
 * anywhere. On a device that cannot hover it is simply always there; the row is
 * taller there and that is correct.
 *
 * It is drawn *over* the marks rather than in place of them, so revealing it
 * changes no geometry at all: the row does not grow, and the preview's
 * ellipsis does not move.
 *
 * The design sketched an overflow `MenuButton` beside it as the always-reachable
 * copy of the same actions. Not built: a row has exactly one action today, and a
 * disclosure wrapping a single item is one more click and one more tab stop for
 * the same thing. The requirement it existed for — never hover-only — is met by
 * the focus-within and coarse-pointer rules above. When a second row action
 * lands, the menu is the right shape for it.
 *
 * ## Two targets, one row
 *
 * The name and preview are a link whose hit area is stretched over the whole
 * row. The action is a **sibling** of that link, not a child — a button inside
 * an anchor is invalid and behaves differently in every browser — lifted above
 * the stretched area so a click on it claims rather than navigates.
 */

export interface ConversationRowProps {
  conversation: ConversationResponse;
  assigneeName: string | null;
  teamName: string | null;
  isSelected: boolean;
  /**
   * This row was not in the list a render ago — the socket pushed it in. It
   * expands into place rather than appearing, so the queue visibly changes
   * instead of shunting under the cursor. `ConversationList` decides it.
   */
  isEntering: boolean;
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
 * back: the filter, the search that produced it, and the order it is in. Shared
 * by the row, the list, its header and the thread's back link so none of them
 * can forget one.
 */
export interface InboxListQuery {
  scope: InboxScope;
  status: ConversationStatusFilter | undefined;
  q?: string;
  sort: ConversationSort;
}

export function ConversationRow({
  conversation,
  assigneeName,
  teamName,
  isSelected,
  isEntering,
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
  // The same chips line two renders, so the link's accessible name cannot
  // announce a status the row is not showing.
  const chips = conversationChips(conversation, query, CHIP_LIMIT.row);

  return (
    <li className={listStyles.item} data-entering={isEntering ? 'true' : undefined}>
      <div
        className={styles.row}
        data-selected={isSelected ? 'true' : undefined}
        data-unread={conversation.unreadCount > 0 ? 'true' : undefined}
      >
        <Avatar name={contactName} size="sm" />

        <div className={styles.content}>
          <div className={styles.line}>
            <Link
              className={styles.contact}
              href={routes.inbox({ ...query, conversationId: conversation.id })}
              // Says which conversation, and what the row shows about it in
              // shape and colour alone — the unread circle and the selection bar.
              aria-label={conversationRowName(contactName, chips, conversation.unreadCount)}
              aria-current={isSelected ? 'true' : undefined}
              scroll={false}
            >
              {contactName}
            </Link>
            <span className={styles.time}>
              <RelativeTime
                isoTimestamp={conversation.lastMessageAt}
                label={content.inbox.lastActivity}
              />
            </span>
          </div>

          <div className={styles.line}>
            <p className={styles.preview}>{conversation.lastMessagePreview ?? ''}</p>
            <div className={styles.marks}>
              <ConversationBadges
                conversation={conversation}
                assigneeName={assigneeName}
                teamName={teamName}
                filter={query}
              />
            </div>
          </div>
        </div>

        {/* Shown only for the direction this reader may actually take: claiming
            is everyone's, releasing and taking over are a supervisor's. */}
        {hold !== null && claim !== null && canChangeHold(hold, claim) ? (
          <div className={styles.actions}>
            <ClaimButton
              conversationId={conversation.id}
              contactName={contactName}
              hold={hold}
              size="sm"
              emphasis="quiet"
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Mirrors `ConversationRow`: the same grid, the same avatar, the same two lines
 * with a trailing cell on each — and therefore the same `--size-row-list`, which
 * the row's own `min-block-size` pins for both. The swap moves nothing.
 *
 * It takes no props. The row's height no longer depends on who is looking —
 * since the action left the resting row, a supervisor's rows and an agent's are
 * the same height — which is why the `hasClaim` reservation this used to need is
 * gone rather than defaulted.
 */
export function ConversationRowSkeleton() {
  return (
    <li className={listStyles.item}>
      <div className={styles.row}>
        <SkeletonCircle size="var(--size-control-sm)" />
        <div className={styles.content}>
          <div className={styles.line}>
            <SkeletonLine width="60%" />
            <SkeletonLine width="3rem" height="var(--font-size-caption)" />
          </div>
          <div className={styles.line}>
            <SkeletonLine width="85%" />
            <SkeletonLine width="4rem" height="var(--font-size-caption)" />
          </div>
        </div>
      </div>
    </li>
  );
}
