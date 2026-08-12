import { content } from '@/content/en';
import type { ConversationStatusFilter, InboxScope } from '@/lib/routes';

/**
 * The inbox's filter column, as data.
 *
 * Every entry is a combination of the two things the API actually filters on —
 * `scope` and `status` — so there is no filter here the list cannot answer. The
 * reference layout this was built against also offers Email, Calls, Sent and
 * Spam; this product has one channel, no outbound-initiated sends and no spam
 * classifier, so those are not entries, they would be lies.
 *
 * Order matters: the first `INBOX_FILTERS_PRIMARY_COUNT` are what an agent sees
 * without asking, and the rest sit behind the column's More/Less boundary.
 */

export interface InboxFilter {
  readonly id: string;
  readonly label: string;
  readonly scope: InboxScope;
  /** Omitted for "every status". */
  readonly status?: ConversationStatusFilter;
}

export const INBOX_FILTERS: readonly InboxFilter[] = [
  { id: 'unassigned', label: content.inbox.filterUnassigned, scope: 'unassigned' },
  { id: 'assigned', label: content.inbox.filterAssigned, scope: 'assigned' },
  { id: 'all-open', label: content.inbox.filterAllOpen, scope: 'all', status: 'open' },
  { id: 'all', label: content.inbox.filterAll, scope: 'all' },
  { id: 'pending', label: content.inbox.filterPending, scope: 'all', status: 'pending' },
  { id: 'resolved', label: content.inbox.filterResolved, scope: 'all', status: 'resolved' },
  { id: 'closed', label: content.inbox.filterClosed, scope: 'all', status: 'closed' },
];

/**
 * Three, and they are the three questions an agent opens the console to answer:
 * what is nobody on, what is on me, and what is still open anywhere. Everything
 * else is a report.
 */
export const INBOX_FILTERS_PRIMARY_COUNT = 3;

/**
 * Which entry the current URL is on, or `null` for a combination no entry names
 * — `scope=unassigned&status=resolved`, say, which is reachable by hand and by
 * an older link. `null` marks nothing rather than guessing, because a column
 * that highlighted the wrong entry would be worse than one that highlighted
 * none.
 */
export function activeInboxFilterId(
  scope: InboxScope,
  status: ConversationStatusFilter | undefined,
): string | null {
  return INBOX_FILTERS.find((filter) => filter.scope === scope && filter.status === status)?.id ?? null;
}
