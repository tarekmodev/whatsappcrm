'use client';

import type { ConversationResponse } from '@whatsappcrm/contracts';
import { Avatar, type AvatarSize } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Cluster } from '@/components/layout/Cluster';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useContent } from '@/lib/content';
import {
  CHIP_LIMIT,
  conversationChips,
  type InboxFilterContext,
} from '@/features/inbox/conversation-chips';
import styles from './ConversationBadges.module.css';

/**
 * What a conversation needs a reader to know, in one row. Usage:
 * `<ConversationBadges conversation={…} assigneeName={…} teamName={…} filter={…} view="row" />`.
 *
 * Shared by the list row and the thread header because the two showed the
 * identical set the moment the thread view existed — and an inbox where a row
 * and the header above it disagree about who owns a conversation is worse than
 * one that says nothing.
 *
 * ## Three kinds of thing, not six pills
 *
 * 0001's "Status vocabulary", which this component is the first consumer of:
 *
 *   * **One status chip** on a row, two in a header — `conversation-chips.ts`
 *     decides which, and drops whatever the active filter has already said.
 *   * **The unread count as a count**, not as the sentence "2 unread" in a pill.
 *   * **Assignment as an avatar** with an accessible name, not as a text pill.
 *     A held thread is a *who*, and a who is a face.
 *
 * Before TAR-514 this rendered all six facts as equal pills, which in the dark
 * theme made a row of solid saturated fills louder than the `Claim` button
 * beside it — the metadata out-shouting the one thing you can press.
 */

export interface ConversationBadgesProps {
  conversation: ConversationResponse;
  assigneeName: string | null;
  teamName: string | null;
  /** The filter the reader is looking through; a chip never repeats it. */
  filter: InboxFilterContext;
  /**
   * A row is scanned and gets one chip plus its unread count; a header is read,
   * gets two, and has no unread count because the thread is open in front of it.
   */
  view?: 'row' | 'detail';
}

export function ConversationBadges({
  conversation,
  assigneeName,
  teamName,
  filter,
  view = 'row',
}: ConversationBadgesProps) {
  const content = useContent();
  const isRow = view === 'row';
  const chips = conversationChips(conversation, filter, isRow ? CHIP_LIMIT.row : CHIP_LIMIT.detail);
  const size = isRow ? 'sm' : 'md';
  // A row is `--size-row-list` tall since TAR-517 and the mark shares its line
  // with a chip and a count, so the holder is the smallest avatar that still
  // reads as one. A header has the room for the ordinary size.
  const avatarSize: AvatarSize = isRow ? 'xs' : 'sm';

  return (
    <Cluster gap="2">
      {chips.map((chip) => (
        <Badge key={chip.key} tone={chip.tone} size={size}>
          {chip.label}
        </Badge>
      ))}

      {isRow && conversation.unreadCount > 0 ? (
        <Badge variant="count" tone="info">
          {conversation.unreadCount}
          {/* The number is the whole chip on screen; this is what makes it a
              sentence for a screen reader rather than a bare digit. */}
          <VisuallyHidden>{content.inbox.unreadUnit}</VisuallyHidden>
        </Badge>
      ) : null}

      {/* Keyed on the *id*, not on the name. The directory read is one page, so a
          tenant past it resolves no name — and dropping the mark for that made a
          thread somebody is holding look unheld, which is the state this row
          exists to report. */}
      {conversation.assignedUserId === null ? null : (
        <Holder
          size={avatarSize}
          name={assigneeName}
          isNamed={!isRow}
          label={
            assigneeName === null
              ? content.inbox.assignedToUnresolved
              : content.inbox.assignedTo(assigneeName)
          }
        />
      )}
      {teamName === null ? null : (
        <Holder
          size={avatarSize}
          name={teamName}
          isNamed={!isRow}
          label={content.inbox.assignedToTeam(teamName)}
        />
      )}
    </Cluster>
  );
}

/**
 * Who holds the thread.
 *
 * On a **row** the avatar stands alone: the column is scanned rather than read,
 * a name would cost it the width its preview line needs, and the label travels
 * beside the mark invisibly for assistive technology and in `title` for a
 * pointer — an initial in a circle is not self-explanatory to either.
 *
 * In a **header** the name is on screen (TAR-518). One conversation is open and
 * being read, there is room for the sentence, and "who is on this" is a question
 * an agent should not have to hover a circle to answer.
 */
function Holder({
  name,
  label,
  size,
  isNamed,
}: {
  name: string | null;
  label: string;
  size: AvatarSize;
  /** Show the label in text beside the mark rather than only to a screen reader. */
  isNamed: boolean;
}) {
  return (
    <span className={styles.holder} title={isNamed ? undefined : label}>
      <Avatar name={name ?? ''} tone="neutral" size={size} />
      {isNamed ? (
        <span className={styles.holderName}>{label}</span>
      ) : (
        <VisuallyHidden>{label}</VisuallyHidden>
      )}
    </span>
  );
}
