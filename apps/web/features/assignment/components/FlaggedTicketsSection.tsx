import { Stack } from '@/components/layout/Stack';
import { FilterPills } from '@/components/ui/FilterPills';
import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import { capacityRemedy } from '../capacity';
import { loadAgentCapacity } from '../capacity.data';
import { loadFlaggedTickets, type FlaggedTicketsFilters } from '../flagged-tickets.data';
import { deferredReasonFilters } from '../flagged-filters';
import { flaggedQueueSummary } from '../flagged-summary';
import { CAPACITY_REASON, countAtCapacity, toFlaggedTicketRows } from '../flagged-rows';
import { CapacityNotice } from './CapacityNotice';
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

        {/* The remedy for the one reason a limit answers, above the table rather
            than inside it — see `CapacityNotice` for why the row was the wrong
            place. It is not reserved in the skeleton below: whether any row is
            at capacity is not known until the rows are, and a placeholder for
            something that may not arrive shifts the page in the other
            direction. */}
        <CapacityNotice
          atCapacityCount={countAtCapacity(rows)}
          isFilteredToCapacity={filters.deferredReason === CAPACITY_REASON}
          remedy={capacityRemedy(canEditCapacity, capacity)}
        />

        {/* Imported directly, not behind a lazy boundary: this is the page's
            primary above-the-fold content, so deferring its chunk would trade a
            skeleton flash for bytes nobody saves. Only the dialogs are lazy, and
            each loads on first open. */}
        <FlaggedTicketsTable
          rows={rows}
          assignableUsers={assignableUsers}
          canAssign={canAssign}
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
