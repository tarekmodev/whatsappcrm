import type { MessageResponse } from '@whatsappcrm/contracts';
import { isBotMessage } from '@/features/inbox/bot-state';

/**
 * Collapses a day's messages into **runs**: consecutive messages from one sender,
 * close together in time, which the thread draws with one avatar and one sender
 * label between them.
 *
 * This is what makes a busy thread readable. A customer who sent four lines in
 * twenty seconds is one person saying one thing, and repeating their name, their
 * face and a timestamp above each line turns a conversation back into a message
 * table — which is the whole complaint TAR-518 exists to answer.
 *
 * Pure, and its own module rather than a loop inside `MessageList`, for the same
 * reason `message-days.ts` is: the rules are worth a test of their own, and a
 * component holding them is a component nobody can check.
 *
 * ## Two things break a run
 *
 * A different sender, obviously. And a **gap**: a reply four hours after the one
 * above it is not part of that utterance, and folding it in would hang the run's
 * single timestamp on the earlier message while the later one silently lost its
 * own. `message-days.ts` has already split calendar days before this sees the
 * list, so the gap rule only has to catch the within-a-day case.
 */

export type MessageSender =
  /** The customer. One identity — a conversation has exactly one contact. */
  | { readonly kind: 'contact' }
  /** The chatbot (TAR-28). Named separately from other automation on purpose. */
  | { readonly kind: 'bot' }
  /** A workflow (TAR-27), or a delivery placeholder the ingest writer created. */
  | { readonly kind: 'automation' }
  | { readonly kind: 'agent'; readonly userId: string }
  /**
   * A person sent it and the directory could not say which — the read is one
   * page of users, so a large tenant has agents beyond it. Distinct from
   * `automation`, because attributing a colleague's words to a machine is a lie
   * about the one thing this product is a record of.
   */
  | { readonly kind: 'teammate' };

export interface MessageRun {
  /** The first message's id. Stable across a refetch, unlike an index. */
  readonly key: string;
  readonly sender: MessageSender;
  /** The instant the run's label points at — its first message. */
  readonly isoTimestamp: string;
  readonly messages: readonly MessageResponse[];
}

/** The same shape while it is still being filled. Assignable to `MessageRun`. */
interface MessageRunBuilder extends Omit<MessageRun, 'messages'> {
  readonly messages: MessageResponse[];
}

/**
 * Five minutes. Long enough that a customer typing three lines in a row stays
 * one run, short enough that a reply after a pause gets its own timestamp — which
 * is the only reason the run's label can carry one time for several bubbles.
 */
export const RUN_GAP_MS = 5 * 60 * 1000;

export function groupMessagesIntoRuns(messages: readonly MessageResponse[]): readonly MessageRun[] {
  const runs: MessageRunBuilder[] = [];

  for (const message of messages) {
    const sender = senderOf(message);
    const current = runs.at(-1);

    if (current !== undefined && sameSender(current.sender, sender) && follows(current, message)) {
      current.messages.push(message);
      continue;
    }

    runs.push({
      key: message.id,
      sender,
      isoTimestamp: message.sentAt,
      messages: [message],
    });
  }

  return runs;
}

/**
 * Who sent a message, in the order the answers are trustworthy — the same order
 * `MessageBubble` used to caption a bubble with, lifted here so the run and the
 * label it draws cannot disagree about it.
 *
 * `origin` first, because it is the only field that names *which* system replied.
 * Then `sentByAutomation`, which is the contract's answer to "was a human
 * involved" — asked **before** the name, because a missing name is not evidence
 * of a bot.
 */
export function senderOf(message: MessageResponse): MessageSender {
  if (message.direction === 'inbound') {
    return { kind: 'contact' };
  }

  if (isBotMessage(message.origin)) {
    return { kind: 'bot' };
  }

  if (message.sentByAutomation) {
    return { kind: 'automation' };
  }

  if (message.sentByUserId !== null) {
    return { kind: 'agent', userId: message.sentByUserId };
  }

  return { kind: 'teammate' };
}

function sameSender(left: MessageSender, right: MessageSender): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === 'agent' && right.kind === 'agent') {
    return left.userId === right.userId;
  }

  return true;
}

/**
 * Whether the message is close enough to the run's *last* one to belong to it.
 * Measured from the last rather than from the run's label, so a long run of
 * quick messages does not eventually time out against its own first entry.
 */
function follows(run: MessageRunBuilder, message: MessageResponse): boolean {
  const previous = run.messages.at(-1);

  if (previous === undefined) {
    return false;
  }

  const gap = Date.parse(message.sentAt) - Date.parse(previous.sentAt);

  // `NaN` from an unparseable timestamp breaks the run rather than joining it:
  // a bubble with its own label is a worse-looking thread, and a bubble folded
  // silently under somebody else's name is a wrong one.
  return Number.isFinite(gap) && gap >= 0 && gap <= RUN_GAP_MS;
}
