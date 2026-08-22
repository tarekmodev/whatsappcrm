import type { ConversationBotState, MessageOrigin } from '@whatsappcrm/contracts';
import type { BadgeTone } from '@/components/ui/Badge';

/**
 * How the chatbot's state reads in the inbox (TAR-28).
 *
 * Pure mapping, no React, so the rules are testable on their own and no
 * component holds one.
 */

/**
 * A badge tone per state — or `null` for the state that gets no badge at all.
 *
 * `off` is deliberately unlabelled. A conversation the chatbot never touched is
 * the ordinary case, and a badge on every row would put a word in front of every
 * reader for no information. The other three each say something the reader
 * cannot get elsewhere:
 *
 *   * `bot_active` — nobody on your team is answering this, and that is expected.
 *   * `handed_off` — the chatbot gave up and **nobody has taken it yet**. This is
 *     the one that needs a person, and it is why the boolean `botHandling` was
 *     not enough: it reads `false` here, exactly as it does for `off`.
 *   * `human_active` — a colleague stepped in, and the chatbot will not resume.
 */
export const BOT_STATE_TONES = {
  off: null,
  bot_active: 'info',
  handed_off: 'warning',
  human_active: 'neutral',
} as const satisfies Record<ConversationBotState, BadgeTone | null>;

/**
 * Whether this conversation's bot state is worth a badge.
 *
 * A function rather than a `!== 'off'` at each call site, because "does this get
 * a badge" and "has the bot been involved" are different questions that happen
 * to have the same answer today — and the second one is `hasBotEngaged` below.
 */
export function hasBotStateBadge(state: ConversationBotState): boolean {
  return BOT_STATE_TONES[state] !== null;
}

/**
 * Whether a conversation in this state can still be taken from the chatbot.
 *
 * `POST /conversations/{id}/handoff` is idempotent by design — a conversation
 * already `handed_off` or `human_active` answers `200` and writes nothing — so
 * this decides whether the console *offers* the control, not what makes it safe.
 * A double-click is a no-op, never a `409`.
 */
export function canRequestHandoff(state: ConversationBotState): boolean {
  return state === 'bot_active';
}

/**
 * Whether the chatbot has been involved at all, and so whether the handoff
 * summary is worth asking for.
 *
 * `off` is the tenant with no bot and the conversation the gate refused
 * silently; both answer `404`, and a request that can only 404 is one the
 * console should not make.
 */
export function hasBotEngaged(state: ConversationBotState): boolean {
  return state !== 'off';
}

/**
 * Whether a message should be attributed to the chatbot by name.
 *
 * Narrower than `sentByAutomation`, and checked before it: a workflow reply
 * (TAR-27) is also automation, and captioning it "Sent by the chatbot" would
 * name the wrong system. Anything that is automation but not `bot` keeps the
 * general caption.
 */
export function isBotMessage(origin: MessageOrigin): boolean {
  return origin === 'bot';
}
