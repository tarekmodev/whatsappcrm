import type { MessageResponse } from '@whatsappcrm/contracts';

/**
 * Splits a thread into the days it happened on, so the list can put a date chip
 * between them.
 *
 * ## Why UTC
 *
 * Grouping is done on the UTC calendar day and the chip is formatted in UTC to
 * match. The alternative — the reader's own zone — would put a different number
 * of chips in the server's HTML than in the browser's, which is a hydration
 * mismatch in the *structure* of the list rather than in one string, and there
 * is no deferring past it the way `RelativeTime` defers a phrase. So both sides
 * agree on one calendar, and the machine-readable value on each chip carries the
 * exact instant for anything that needs it.
 *
 * That costs a message sent late at night far from UTC its "correct" chip. It is
 * the same trade `RelativeTime`'s server-rendered value makes, and it is the one
 * that cannot render two different lists.
 */

export interface MessageDay {
  /** `YYYY-MM-DD` in UTC. Stable, and the list's key. */
  readonly key: string;
  /** The chip's text, already formatted. */
  readonly label: string;
  /** The instant the chip's `<time>` points at — the day's first message. */
  readonly isoTimestamp: string;
  readonly messages: readonly MessageResponse[];
}

/** The same shape while it is still being filled. Assignable to `MessageDay`. */
interface MessageDayBuilder extends Omit<MessageDay, 'messages'> {
  readonly messages: MessageResponse[];
}

export function groupMessagesByDay(messages: readonly MessageResponse[]): readonly MessageDay[] {
  const days: MessageDayBuilder[] = [];

  for (const message of messages) {
    const key = utcDayKey(message.sentAt);
    const current = days.at(-1);

    if (current !== undefined && current.key === key) {
      current.messages.push(message);
      continue;
    }

    days.push({
      key,
      label: formatDay(message.sentAt),
      isoTimestamp: message.sentAt,
      messages: [message],
    });
  }

  return days;
}

/** The ISO date part, which is already the UTC calendar day. */
function utcDayKey(isoTimestamp: string): string {
  return new Date(isoTimestamp).toISOString().slice(0, DATE_LENGTH);
}

const DATE_LENGTH = 10;

function formatDay(isoTimestamp: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(isoTimestamp));
}
