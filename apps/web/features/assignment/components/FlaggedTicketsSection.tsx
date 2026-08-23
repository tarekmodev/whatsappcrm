import { Stack } from '@/components/layout/Stack';
import { FilterPills } from '@/components/ui/FilterPills';
import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import { loadAgentCapacity } from '../capacity.data';
import { loadFlaggedTickets, type FlaggedTicketsFilters } from '../flagged-tickets.data';
import { deferredReasonFilters } from '../flagged-filters';
import { flaggedQueueSummary } from '../flagged-summary';
import { toFlaggedTicketRows } from '../flagged-rows';
import { FlaggedTicketsTable } from './FlaggedTicketsTable';
import { FlaggedTicketsTableSkeleton } from './FlaggedTicketsTable.Skeleton';

/**
 * Tickets auto-assignment could not place — TAR-23's second acceptance criterion,
 * seen from the supervisor's side. Usage: inside a Suspense boundary on the
 * Assignment page, with `FlaggedTicketsSectionSkeleton` as the fallback.
 *
 * A server component: the fetch and the permission decision both happen on the
 * server, and only the table's own chunk reaches the browser.
 */

export async function FlaggedTicketsSection({
  filters,
  canAssign,
  canEditCapacity,
}: {
  filters: FlaggedTicketsFilters;
  /** From the caller's `ticket:assign` check. The action asserts it again. */
  canAssign: boolean;
  /** From the caller's `assignment_rule:write` check. The action asserts it again. */
  canEditCapacity: boolean;
}) {
  // In parallel, not in sequence: the queue and the agents' limits are two
  // independent reads, and awaiting one before starting the other would add a
  // round trip to the section's time to first byte for nothing.
  const [{ tickets, hasMore, assignableUsers, teams }, capacity] = await Promise.all([
    loadFlaggedTickets(filters),
    loadAgentCapacity(canEditCapacity),
  ]);
  const rows = toFlaggedTicketRows(tickets, teams);
  const summary = flaggedQueueSummary(rows.length, hasMore, content);

  return (
    <SectionCard
      id="flagged"
      title={content.assignment.flaggedHeading}
      description={content.assignment.flaggedDescription}
    >
      <Stack gap="4">
        {/* Describes the rows on screen and admits when there are more. The
            reason filter is applied by the query, so a narrowed view is a real
            answer about the whole queue rather than about one page of it. */}
        {summary === null ? null : <p>{summary}</p>}

        <FilterPills
          label={content.assignment.reasonFilterLabel}
          items={deferredReasonFilters(content, filters.deferredReason)}
        />

        {/* Imported directly, not behind a lazy boundary: this is the page's
            primary above-the-fold content, so deferring its chunk would trade a
            skeleton flash for bytes nobody saves. Only the assign dialog is
            lazy, and it loads on first open. */}
        <FlaggedTicketsTable
          rows={rows}
          assignableUsers={assignableUsers}
          canAssign={canAssign}
          capacity={capacity}
          isFiltered={filters.deferredReason !== undefined}
        />
      </Stack>
    </SectionCard>
  );
}

/**
 * The fallback. Same card, same description, same filter strip and the table's own
 * skeleton, so nothing moves when the data arrives.
 *
 * The count line is a non-breaking space rather than a guess: a number that
 * changes on arrival is worse than one that appears, and the reserved line keeps
 * the strip below it in place either way.
 */
export function FlaggedTicketsSectionSkeleton({
  hasRowActions = true,
}: {
  hasRowActions?: boolean;
}) {
  return (
    <SectionCard
      id="flagged"
      title={content.assignment.flaggedHeading}
      description={content.assignment.flaggedDescription}
    >
      <Stack gap="4">
        <p aria-hidden="true">&nbsp;</p>
        <FilterPills
          label={content.assignment.reasonFilterLabel}
          items={deferredReasonFilters(content, undefined)}
        />
        <FlaggedTicketsTableSkeleton hasRowActions={hasRowActions} />
      </Stack>
    </SectionCard>
  );
}
