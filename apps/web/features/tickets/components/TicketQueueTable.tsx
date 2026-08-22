import Link from 'next/link';
import type { TicketResponse } from '@whatsappcrm/contracts';
import { Avatar } from '@/components/ui/Avatar';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { TextLink } from '@/components/ui/TextLink';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { TICKETS_PAGE_SIZE } from '@/features/tickets/constants';
import { ticketAssignee } from '@/features/tickets/presentation';
import { ticketMarkEmphasis, type TicketMarkEmphasis } from '@/features/tickets/ticket-chips';
import { isTicketQueueFiltered, type TicketQueueParams } from '@/features/tickets/ticket-params';
import { SlaIndicator } from '@/features/sla/components/SlaIndicator';
import { firstResponseIndicator, ticketRowTone } from '@/features/sla/presentation';
import { TicketPriorityBadge, TicketStatusBadge } from './TicketBadges';
import { ticketColumnMeta } from './ticket-columns';
import styles from './TicketQueueTable.module.css';

/**
 * The ticket queue. Usage:
 * `<TicketQueueTable tickets={tickets} userNames={…} teamNames={…} params={…} />`.
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
 *
 * **At most two of a row's three marks are pills** — `ticket-chips.ts` decides
 * which, and the losers render the same word as muted text (TAR-520). Three
 * badges on one row is three things competing for one glance.
 */

export interface TicketQueueTableProps {
  tickets: readonly TicketResponse[];
  userNames: ReadonlyMap<string, string>;
  teamNames: ReadonlyMap<string, string>;
  /**
   * The view these rows are the answer to. It decides which of the two empty
   * states this table shows, and which marks a row would only be repeating from
   * the filter bar above it.
   */
  params: TicketQueueParams;
}

export function TicketQueueTable({ tickets, userNames, teamNames, params }: TicketQueueTableProps) {
  if (tickets.length === 0) {
    // Two states, not one heading with two bodies: "this filter has nothing in
    // it" is answerable — widen it — and "nothing is waiting" is not.
    return isTicketQueueFiltered(params) ? (
      <EmptyState
        icon="filter"
        title={content.tickets.emptyFilteredHeading}
        description={content.tickets.emptyFilteredBody}
        action={
          <TextLink href={routes.tickets({ scope: 'all' })}>
            {content.tickets.emptyFilteredAction}
          </TextLink>
        }
      />
    ) : (
      <EmptyState
        icon="ticket"
        title={content.tickets.emptyHeading}
        description={content.tickets.emptyBody}
      />
    );
  }

  const columns: DataTableColumn<TicketResponse>[] = ticketColumnMeta(content).map((meta) => ({
    ...meta,
    render: (ticket) => renderCell(meta.key, ticket, userNames, teamNames, params),
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
  params: TicketQueueParams,
) {
  // The first-response timer only. The resolution timer is null on every seeded
  // policy (ADR 0006 decision 6), and a column that showed both would be two
  // badges wide for a value that is always half empty. The ticket view carries
  // both.
  const sla = firstResponseIndicator(ticket.sla);
  const emphasis: TicketMarkEmphasis = ticketMarkEmphasis(ticket, sla?.state ?? null, params);

  switch (key) {
    case 'ticket':
      return <TicketCell ticket={ticket} />;
    case 'priority':
      return <TicketPriorityBadge priority={ticket.priority} isEmphasised={emphasis.priority} />;
    case 'status':
      return <TicketStatusBadge status={ticket.status} isEmphasised={emphasis.status} />;
    case 'sla':
      return <SlaIndicator indicator={sla} isEmphasised={emphasis.sla} />;
    case 'assignee':
      return <AssigneeCell ticket={ticket} userNames={userNames} teamNames={teamNames} />;
    case 'opened':
      return <RelativeTime isoTimestamp={ticket.createdAt} label={content.tickets.openedAt} />;
    default:
      return null;
  }
}

/**
 * The subject over the reference. An auto-created ticket has no subject, and
 * borrowing `ticketLabel`'s sentence form for the title printed "Ticket #1044"
 * over "#1044" — the same number twice, in two type sizes (TAR-520). The
 * placeholder says what is missing instead, and the reference stays on its own
 * line where a row that *does* have a subject also carries it.
 */
function TicketCell({ ticket }: { ticket: TicketResponse }) {
  return (
    <Link className={styles.link} href={routes.ticket(ticket.id)}>
      <span
        className={styles.subject}
        data-placeholder={ticket.subject === null ? 'true' : undefined}
      >
        {ticket.subject ?? content.tickets.noSubject}
      </span>
      {/* `dir="ltr"`: a reference number reads left to right whatever the
          surrounding text direction is. */}
      <span className={styles.reference} dir="ltr">
        {content.tickets.reference(ticket.number)}
      </span>
    </Link>
  );
}

/**
 * Who holds the ticket: an `Avatar` beside the name, matching the conversation
 * row's treatment of the same fact (TAR-517) — 0001's status vocabulary is
 * explicit that assignment is a face rather than a text pill.
 *
 * **Nobody gets no face.** `Unassigned` is the absence of a holder, and a circle
 * with a `U` in it would read as a person called that. It stays muted text, which
 * is also what makes an unassigned row visibly different while scanning.
 */
function AssigneeCell({
  ticket,
  userNames,
  teamNames,
}: {
  ticket: TicketResponse;
  userNames: ReadonlyMap<string, string>;
  teamNames: ReadonlyMap<string, string>;
}) {
  const { label, isHeld } = ticketAssignee(ticket, userNames, teamNames);

  if (!isHeld) {
    return <span className={styles.assignee}>{label}</span>;
  }

  return (
    <span className={styles.assignee} data-held="true">
      <Avatar name={label} size="xs" tone="neutral" />
      <span className={styles.assigneeName}>{label}</span>
    </span>
  );
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
