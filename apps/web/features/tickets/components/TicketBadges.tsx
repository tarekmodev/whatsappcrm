import type { TicketPriority, TicketStatus } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { content } from '@/content/en';
import { TICKET_PRIORITY_TONES, TICKET_STATUS_TONES } from '@/features/tickets/presentation';

/**
 * A ticket's status and priority as labels. Usage:
 * `<TicketStatusBadge status={ticket.status} />`.
 *
 * Two one-line components rather than inline `<Badge>` calls because the queue
 * row, the detail header and the control panel all render them: the tone table
 * is read once, and a status relabelled later changes one file.
 */

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={TICKET_STATUS_TONES[status]}>{content.ticketStatuses[status]}</Badge>;
}

export function TicketPriorityBadge({ priority }: { priority: TicketPriority }) {
  return <Badge tone={TICKET_PRIORITY_TONES[priority]}>{content.ticketPriorities[priority]}</Badge>;
}
