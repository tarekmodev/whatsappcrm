import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { loadTicketQueue } from '@/features/tickets/tickets.data';
import type { TicketQueueParams } from '@/features/tickets/ticket-params';
import { TicketQueueTable, TicketQueueTableSkeleton } from './TicketQueueTable';

/**
 * Fetches and renders the ticket queue. Usage: inside a Suspense boundary on the
 * tickets page, with `TicketQueueSectionSkeleton` as the fallback.
 */

export interface TicketQueueSectionProps {
  params: TicketQueueParams;
  /** True when the API answers `all` with less than the whole workspace. */
  isScopeNarrowed: boolean;
}

export async function TicketQueueSection({ params, isScopeNarrowed }: TicketQueueSectionProps) {
  const { tickets, userNames, teamNames } = await loadTicketQueue(params);

  return (
    <SectionCard
      id="ticket-queue"
      title={content.tickets.queueHeading}
      description={content.tickets.queueOrderNotice}
    >
      <Stack gap="3">
        {isScopeNarrowed ? (
          // The API narrows `all` rather than refusing it; saying so is what
          // stops an agent wondering why a shared supervisor link shows so
          // little.
          <Notice tone="info">{content.tickets.scopeNarrowedNotice}</Notice>
        ) : null}
        <TicketQueueTable
          tickets={tickets}
          userNames={userNames}
          teamNames={teamNames}
          isFiltered={isFiltered(params)}
        />
      </Stack>
    </SectionCard>
  );
}

/** Anything beyond the default view — the active queue, assigned to me. */
function isFiltered(params: TicketQueueParams): boolean {
  return (
    params.status !== undefined ||
    params.priority !== undefined ||
    params.scope !== 'assigned' ||
    params.isOverdueOnly
  );
}

/**
 * Mirrors `TicketQueueSection`'s frame, with the queue's own skeleton inside it.
 * The description line is the real one — it renders from a constant, and drawing
 * a placeholder over something already known would be slower and emptier.
 */
export function TicketQueueSectionSkeleton() {
  return (
    <SectionCard
      id="ticket-queue"
      title={content.tickets.queueHeading}
      description={content.tickets.queueOrderNotice}
    >
      <TicketQueueTableSkeleton />
    </SectionCard>
  );
}
