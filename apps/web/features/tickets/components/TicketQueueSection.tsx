import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { loadTicketQueue } from '@/features/tickets/tickets.data';
import type { TicketQueueParams } from '@/features/tickets/ticket-params';
import { TicketQueueHeader, TicketQueueHeaderSkeleton } from './TicketQueueHeader';
import { TicketQueueTable, TicketQueueTableSkeleton } from './TicketQueueTable';

/**
 * Fetches and renders the ticket queue. Usage: inside a Suspense boundary on the
 * tickets page, with `TicketQueueSectionSkeleton` as the fallback.
 *
 * **The card's title is hidden** (TAR-520). "Ticket queue" under an `<h1>`
 * reading "Tickets" is the same word twice, and this route has one card — so the
 * name stays for the document outline and the region label, and the visible top
 * of the card is `TicketQueueHeader`: the count, and the order.
 */

export interface TicketQueueSectionProps {
  params: TicketQueueParams;
  /** True when the API answers `all` with less than the whole workspace. */
  isScopeNarrowed: boolean;
}

export async function TicketQueueSection({ params, isScopeNarrowed }: TicketQueueSectionProps) {
  const { tickets, hasMore, userNames, teamNames } = await loadTicketQueue(params);

  return (
    <SectionCard id="ticket-queue" title={content.tickets.queueHeading} isTitleVisible={false}>
      <Stack gap="3">
        {isScopeNarrowed ? (
          // The API narrows `all` rather than refusing it; saying so is what
          // stops an agent wondering why a shared supervisor link shows so
          // little.
          <Notice tone="info">{content.tickets.scopeNarrowedNotice}</Notice>
        ) : null}
        {/* Suppressed on an empty queue: "0 tickets, sorted by urgent first" is a
            bar of metadata about nothing, above a state whose whole job is to
            explain the nothing. */}
        {tickets.length === 0 ? null : (
          <TicketQueueHeader count={tickets.length} hasMore={hasMore} />
        )}
        <TicketQueueTable
          tickets={tickets}
          userNames={userNames}
          teamNames={teamNames}
          params={params}
        />
      </Stack>
    </SectionCard>
  );
}

/**
 * Mirrors `TicketQueueSection`'s frame, with the queue's own header and table
 * skeletons inside it. The order half of the header is the real one — it renders
 * from a constant, and drawing a placeholder over something already known would
 * be slower and emptier.
 */
export function TicketQueueSectionSkeleton() {
  return (
    <SectionCard id="ticket-queue" title={content.tickets.queueHeading} isTitleVisible={false}>
      <Stack gap="3">
        <TicketQueueHeaderSkeleton />
        <TicketQueueTableSkeleton />
      </Stack>
    </SectionCard>
  );
}
