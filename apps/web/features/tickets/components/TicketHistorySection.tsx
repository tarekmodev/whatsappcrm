import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import { loadTicketHistory } from '@/features/tickets/ticket-history.data';
import { TicketHistoryList } from './TicketHistoryList';
import { TicketHistoryListSkeleton } from './TicketHistoryList.Skeleton';

/**
 * Fetches one ticket's audit trail and renders it in its own card. Usage: inside
 * its own Suspense boundary on the ticket page, keyed on the id, with
 * `TicketHistorySectionSkeleton` as the fallback.
 *
 * A **separate** boundary from `TicketDetailSection`, deliberately: the trail is
 * a second round trip, and putting it behind the same fallback would hold the
 * status controls back until the history arrived. It also fails independently —
 * a broken history must not take the controls down with it, which is what the
 * page's per-section error boundary is for.
 *
 * The `unavailable` branch renders the empty state rather than an error. The API
 * answers `not_found` for a ticket this reader may not see, and by the time this
 * renders the detail section beside it has already said so properly; a second
 * "not available to you" card would say it twice.
 */
export async function TicketHistorySection({ ticketId }: { ticketId: string }) {
  const result = await loadTicketHistory(ticketId);

  const [entries, hasMore] =
    result.outcome === 'ready'
      ? ([result.history.entries, result.history.hasMore] as const)
      : ([[], false] as const);

  return (
    <SectionCard
      id="ticket-history"
      title={content.tickets.historyHeading}
      description={content.tickets.historyDescription}
    >
      <TicketHistoryList entries={entries} hasMore={hasMore} />
    </SectionCard>
  );
}

/**
 * Mirrors `TicketHistorySection`: the same card with the same heading and
 * description — both of which are constants and have nothing to wait for — over
 * the list's own skeleton, so the swap moves nothing above it.
 *
 * The announcement is the one polite message that stands in for the whole
 * region; the placeholder rows themselves are `aria-hidden`.
 */
export function TicketHistorySectionSkeleton() {
  return (
    <SectionCard
      id="ticket-history"
      title={content.tickets.historyHeading}
      description={content.tickets.historyDescription}
    >
      <LoadingAnnouncement label={content.tickets.historyLoading} />
      <TicketHistoryListSkeleton />
    </SectionCard>
  );
}
