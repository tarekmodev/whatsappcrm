import type { TicketPriority, TicketStatus } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { content } from '@/content/en';
import { TICKET_PRIORITY_TONES, TICKET_STATUS_TONES } from '@/features/tickets/presentation';

/**
 * A ticket's status and priority as labels. Usage:
 * `<TicketStatusBadge status={ticket.status} />`, or
 * `<TicketStatusBadge status={ticket.status} isEmphasised={false} />` for a mark
 * that lost its row's chip budget.
 *
 * Two one-line components rather than inline `<Badge>` calls because the queue
 * row, the detail header and the control panel all render them: the tone table
 * is read once, and a status relabelled later changes one file.
 *
 * `isEmphasised` is `ticket-chips.ts`'s answer, and it is the only thing that
 * decides between a pill and muted text — never the call site's own judgement,
 * or the queue and the ticket header would disagree about which marks shout.
 */

export interface TicketMarkProps {
  /** `false` renders `Badge`'s `quiet` variant: same word, no pill (TAR-520). */
  isEmphasised?: boolean;
}

export function TicketStatusBadge({
  status,
  isEmphasised = true,
}: { status: TicketStatus } & TicketMarkProps) {
  return (
    <Badge tone={TICKET_STATUS_TONES[status]} variant={isEmphasised ? 'subtle' : 'quiet'}>
      {content.ticketStatuses[status]}
    </Badge>
  );
}

export function TicketPriorityBadge({
  priority,
  isEmphasised = true,
}: { priority: TicketPriority } & TicketMarkProps) {
  return (
    <Badge tone={TICKET_PRIORITY_TONES[priority]} variant={isEmphasised ? 'subtle' : 'quiet'}>
      {content.ticketPriorities[priority]}
    </Badge>
  );
}
