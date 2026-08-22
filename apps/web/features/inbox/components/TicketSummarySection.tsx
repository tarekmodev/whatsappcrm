import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { TextLink } from '@/components/ui/TextLink';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { nameFor } from '@/features/inbox/directory.data';
import { loadTicketSummary } from '@/features/inbox/ticket-summary.data';
import { TicketPriorityBadge, TicketStatusBadge } from '@/features/tickets/components/TicketBadges';
import styles from './InboxContextPanel.module.css';

/**
 * Where the ticket behind the open conversation has got to. Usage: inside a
 * Suspense boundary in `InboxContextPanel`'s ticket card, keyed on the ticket
 * id, with `TicketSummarySkeleton` as the fallback.
 *
 * It **reports** the link rather than offering to make one, which is the same
 * rule the card around it follows: `TicketLinkerService` puts every inbound
 * message on a ticket, and 0002's endpoint table has no `POST /tickets` for
 * exactly that reason. What was missing until TAR-518 is everything *about* the
 * ticket — an agent could see that one existed and had to open another route to
 * learn whether anybody was on it.
 *
 * The badges are `features/tickets`' own. Two components that differ only in
 * which file they live in would be two tone tables, and a status relabelled in
 * the queue that stayed the old word here.
 */
export async function TicketSummarySection({ ticketId }: { ticketId: string }) {
  const result = await loadTicketSummary(ticketId);

  if (result.outcome === 'unavailable') {
    // A ticket this reader may not open. Said plainly rather than left as an
    // empty card, and without a Retry: the answer will not change on a second
    // attempt.
    return <p className={styles.detail}>{content.inbox.ticketUnavailable}</p>;
  }

  const { ticket, userNames, teamNames } = result.summary;
  const assigneeName = nameFor(userNames, ticket.assignedUserId);
  const teamName = nameFor(teamNames, ticket.assignedTeamId);
  const reference = content.tickets.reference(ticket.number);

  const items: readonly DetailListItem[] = [
    { id: 'reference', term: content.inbox.ticketReferenceLabel, value: reference },
    {
      id: 'status',
      term: content.tickets.columnStatus,
      value: <TicketStatusBadge status={ticket.status} />,
    },
    {
      id: 'priority',
      term: content.tickets.columnPriority,
      value: <TicketPriorityBadge priority={ticket.priority} />,
    },
    {
      id: 'assignee',
      term: content.tickets.columnAssignee,
      // Nobody is a real answer here and the commonest one on a fresh ticket:
      // the auto-linker opens it, and routing assigns it afterwards or not at
      // all. An empty value would read as a field that failed to load.
      value: assigneeName ?? teamName ?? content.inbox.assignedToNobody,
    },
  ];

  return (
    <Stack gap="3">
      <p className={styles.detail}>{content.inbox.ticketLinkedBody}</p>
      <DetailList items={items} />
      <TextLink href={routes.ticket(ticket.id)}>{content.tickets.openTicket(reference)}</TextLink>
    </Stack>
  );
}

/**
 * Mirrors `TicketSummarySection`: the same explanatory line, four term/value
 * rows and the link — so the swap to a real ticket moves nothing.
 */
export function TicketSummarySkeleton() {
  return (
    <Stack gap="3" aria-hidden="true">
      <SkeletonText lines={2} />
      <Stack gap="2">
        {Array.from({ length: TICKET_DETAIL_ROWS }, (_unused, index) => (
          <SkeletonLine key={index} />
        ))}
      </Stack>
      <SkeletonLine width="8rem" />
    </Stack>
  );
}

/** Reference, status, priority, assignee — the four rows the real card renders. */
const TICKET_DETAIL_ROWS = 4;
