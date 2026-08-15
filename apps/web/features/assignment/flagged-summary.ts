import type { Content } from '@/lib/content';

/**
 * The sentence above the flagged queue.
 *
 * A pure function with its own tests, because this line is the one thing on the
 * page that makes a claim about tickets it cannot see. It counts **the rows that
 * are actually rendered** — not the tickets fetched, which can be more once
 * `toFlaggedTicketRows` drops a ticket whose routing columns disagree, and not
 * the queue, which can be more still once the page is capped.
 *
 * `null` means say nothing: an empty, untruncated queue is already explained by
 * the table's own empty state, and "0 tickets flagged" above "Nothing is stuck"
 * is two sentences for one fact.
 */
export function flaggedQueueSummary(
  rowCount: number,
  hasMore: boolean,
  content: Content,
): string | null {
  if (hasMore) {
    return content.assignment.flaggedShowingOldest(rowCount);
  }

  return rowCount === 0 ? null : content.assignment.flaggedCount(rowCount);
}
