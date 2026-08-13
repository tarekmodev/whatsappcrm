import Link from 'next/link';
import type { TicketResponse } from '@whatsappcrm/contracts';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { TICKETS_PAGE_SIZE } from '@/features/tickets/constants';
import { assigneeLabelFor, ticketLabel } from '@/features/tickets/presentation';
import { SlaIndicator } from '@/features/sla/components/SlaIndicator';
import { firstResponseIndicator, ticketRowTone } from '@/features/sla/presentation';
import { TicketPriorityBadge, TicketStatusBadge } from './TicketBadges';
import { ticketColumnMeta } from './ticket-columns';
import styles from './TicketQueueTable.module.css';

/**
 * The ticket queue. Usage:
 * `<TicketQueueTable tickets={tickets} userNames={…} teamNames={…} isFiltered={…} />`.
 *
 * A server component: every row is a link and a set of labels, so there is
 * nothing here to hydrate. Changing a ticket happens on the ticket itself, where
 * a resolve can be confirmed and a conflict explained — a queue that could
 * resolve a row in place would be doing it without the one thing an agent needs
 * to see first, which is whether the customer has just written back.
 *
 * **Rows are rendered in the order the API returned them.** That order is
 * `priority DESC, createdAt DESC, id DESC` — urgent first — and the console does
 * not re-sort it (ADR 0006 §6). An overdue ticket is therefore *flagged* rather
 * than floated to the top: a second ordering rule applied here would disagree
 * with the cursor the API paged by, and the Overdue filter is how a supervisor
 * asks for only those.
 */

export interface TicketQueueTableProps {
  tickets: readonly TicketResponse[];
  userNames: ReadonlyMap<string, string>;
  teamNames: ReadonlyMap<string, string>;
  /**
   * True when the caller narrowed the queue with a status, priority or scope
   * beyond the default. "Nothing matches this filter" and "no tickets yet" are
   * different answers, and telling somebody tickets will appear here when they
   * just filtered to `closed` reads as a broken filter.
   */
  isFiltered: boolean;
}

export function TicketQueueTable({
  tickets,
  userNames,
  teamNames,
  isFiltered,
}: TicketQueueTableProps) {
  if (tickets.length === 0) {
    return (
      <EmptyState
        heading={content.tickets.emptyHeading}
        body={isFiltered ? content.tickets.emptyFilteredBody : content.tickets.emptyBody}
      />
    );
  }

  const columns: DataTableColumn<TicketResponse>[] = ticketColumnMeta(content).map((meta) => ({
    ...meta,
    render: (ticket) => renderCell(meta.key, ticket, userNames, teamNames),
  }));

  return (
    <DataTable
      caption={content.tickets.queueHeading}
      columns={columns}
      rows={tickets}
      getRowKey={(ticket) => ticket.id}
      // Decoration beside the SLA cell, which says "Overdue" in words. The rule
      // down the row is what makes a breach findable while scrolling; the badge
      // is what makes it readable.
      getRowTone={(ticket) => ticketRowTone(ticket.sla)}
    />
  );
}

function renderCell(
  key: string,
  ticket: TicketResponse,
  userNames: ReadonlyMap<string, string>,
  teamNames: ReadonlyMap<string, string>,
) {
  const label = ticketLabel(ticket);

  switch (key) {
    case 'ticket':
      return (
        <Link className={styles.link} href={routes.ticket(ticket.id)}>
          <span className={styles.subject}>{label}</span>
          {/* `dir="ltr"`: a reference number reads left to right whatever the
              surrounding text direction is. */}
          <span className={styles.reference} dir="ltr">
            {content.tickets.reference(ticket.number)}
          </span>
        </Link>
      );
    case 'priority':
      return <TicketPriorityBadge priority={ticket.priority} />;
    case 'status':
      return <TicketStatusBadge status={ticket.status} />;
    case 'sla':
      // The first-response timer only. The resolution timer is null on every
      // seeded policy (ADR 0006 decision 6), and a column that showed both would
      // be two badges wide for a value that is always half empty. The ticket
      // view carries both.
      return <SlaIndicator indicator={firstResponseIndicator(ticket.sla)} />;
    case 'assignee':
      return (
        <span className={styles.assignee}>{assigneeLabelFor(ticket, userNames, teamNames)}</span>
      );
    case 'opened':
      return <RelativeTime isoTimestamp={ticket.createdAt} label={content.tickets.openedAt} />;
    default:
      return null;
  }
}

/**
 * Mirrors the loaded queue exactly — it *is* the same table, with the same
 * columns and placeholder cells — so the swap to real data shifts nothing. Row
 * count matches the page size the server requests.
 */
export function TicketQueueTableSkeleton() {
  return (
    <>
      <LoadingAnnouncement label={content.tickets.queueLoading} />
      <DataTableSkeleton
        caption={content.tickets.queueHeading}
        rowCount={TICKETS_PAGE_SIZE}
        columns={ticketColumnMeta(content).map((meta) => ({ ...meta, render: () => null }))}
      />
    </>
  );
}
