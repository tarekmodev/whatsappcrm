import type {
  ConversationBotState,
  ConversationResponse,
  ConversationStatus,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { BadgeTone } from '@/components/ui/Badge';
import type { ConversationStatusFilter, InboxScope } from '@/lib/routes';
import { BOT_STATE_TONES } from '@/features/inbox/bot-state';

/**
 * Which status chip a conversation earns, and in what order (TAR-514).
 *
 * Pure mapping, no React, so the rule is testable on its own and neither the row
 * nor the thread header holds a copy of it.
 *
 * ## Why this exists
 *
 * The inbox used to render every fact it had as its own pill — status, unread,
 * assignee, team, unclaimed, bot state — so a row could carry five, and in the
 * dark theme all five were solid saturated fills louder than the `Claim` button
 * beside them. 0001's "Status vocabulary" is the rule that came out of that: a
 * list row shows **at most one** status chip and a detail header at most two.
 *
 * Ordering it therefore has to be a decision, not an accident. It runs
 * most-actionable first, which is the same argument `bot-state.ts` already makes
 * for `handed_off`: the chip goes to whatever the reader can least afford to
 * miss, and everything under it is available in the thread.
 *
 * ## What is not a chip
 *
 * * **`open`.** It is the ordinary state of a conversation in an inbox, and a
 *   word on every row is a word no reader gains anything from — the same
 *   argument that leaves bot state `off` unlabelled. Its absence says it.
 * * **A status the filter already names.** "Open" under the "All open" filter,
 *   "Unclaimed" under "Unassigned": the column on the left has just said it.
 * * **Assignment.** An avatar with an accessible name, never a text pill.
 * * **The unread count.** `Badge variant="count"`, never a sentence in a pill.
 */

export interface ConversationChip {
  /** Stable across re-renders and across the reasons a chip can change. */
  readonly key: string;
  readonly tone: BadgeTone;
  readonly label: string;
}

/** The current filter, which decides what a chip would only be repeating. */
export interface InboxFilterContext {
  readonly scope: InboxScope;
  readonly status: ConversationStatusFilter | undefined;
}

/**
 * A list row gets one, a detail header two. Not a preference: a row is scanned
 * and a header is read, and the second chip is what turns a scan into a read.
 */
export const CHIP_LIMIT = { row: 1, detail: 2 } as const;

/**
 * Conversation status as a tone. Separate from `TICKET_STATUS_TONES` even though
 * the four names coincide: they are different contracts, and a conversation
 * moving to `pending` is not a ticket moving to `pending`. `open` is absent
 * because it never earns a chip.
 */
const STATUS_TONES: Record<Exclude<ConversationStatus, 'open'>, BadgeTone> = {
  pending: 'warning',
  resolved: 'success',
  closed: 'neutral',
};

export function conversationChips(
  conversation: ConversationResponse,
  filter: InboxFilterContext,
  limit: number,
): ConversationChip[] {
  const isUnclaimed = conversation.assignedUserId === null && conversation.assignedTeamId === null;

  const candidates: (ConversationChip | null)[] = [
    // The chatbot gave up and nobody has taken it. The one state that needs a
    // person now, so it outranks everything else a row could say.
    botChip(conversation.botState, 'handed_off'),

    // Nobody holds this thread. Redundant under the filter that selects for it.
    isUnclaimed && filter.scope !== 'unassigned'
      ? { key: 'unclaimed', tone: 'warning', label: content.inbox.unclaimed }
      : null,

    // Why nobody on the team has replied. Without it the thread reads as ignored.
    botChip(conversation.botState, 'bot_active'),

    statusChip(conversation.status, filter.status),

    // A colleague stepped in and the chatbot will not resume. Worth saying, but
    // only once nothing above it needs the slot — `pending` is more actionable.
    botChip(conversation.botState, 'human_active'),
  ];

  return candidates.filter((chip): chip is ConversationChip => chip !== null).slice(0, limit);
}

/**
 * What a row's link is called (TAR-517): the contact, then everything the row
 * says about them in something other than words.
 *
 * At 64px a row carries its unread state as a count circle and its selection as
 * an accent bar — both of which are shape and colour and nothing else. 0001
 * forbids colour as the sole carrier, so the same facts travel in the link's own
 * accessible name: "Open the conversation with Fatima Al-Zahra, 2 unread, Bot
 * handed over".
 *
 * Composed from the chips the row actually rendered rather than recomputed, so
 * the name cannot claim a status the row is not showing.
 */
export function conversationRowName(
  contactName: string,
  chips: readonly ConversationChip[],
  unreadCount: number,
): string {
  return [
    content.inbox.openConversation(contactName),
    ...(unreadCount > 0 ? [content.inbox.unreadSummary(unreadCount)] : []),
    ...chips.map((chip) => chip.label),
  ].join(', ');
}

/**
 * The bot's chip when the conversation is in `at`, so a single bot state can be
 * offered at three different ranks without the tone or the label being restated
 * at each one. `off` is excluded by the type: it is the state `bot-state.ts`
 * deliberately leaves unlabelled.
 */
function botChip(
  state: ConversationBotState,
  at: Exclude<ConversationBotState, 'off'>,
): ConversationChip | null {
  return state === at
    ? { key: 'bot', tone: BOT_STATE_TONES[at], label: content.inbox.botStates[at] }
    : null;
}

function statusChip(
  status: ConversationStatus,
  filtered: ConversationStatusFilter | undefined,
): ConversationChip | null {
  if (status === 'open' || status === filtered) {
    return null;
  }

  return {
    key: 'status',
    tone: STATUS_TONES[status],
    label: content.conversationStatuses[status],
  };
}
