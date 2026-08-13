import type { TicketResponse } from '@whatsappcrm/contracts';
import type { DataTableColumn } from '@/components/ui/DataTable';
import type { Content } from '@/lib/content';

/**
 * Column metadata for the ticket queue, without the cell renderers.
 *
 * The real table and its skeleton both build from this, which is what keeps the
 * skeleton from drifting: adding a column changes one array and both stay in
 * step.
 *
 * The order is the order the queue is sorted by — priority sits beside status,
 * near the front, because it is what decides where a row lands.
 */

export type TicketColumnMeta = Omit<DataTableColumn<TicketResponse>, 'render'>;

export function ticketColumnMeta(content: Content): TicketColumnMeta[] {
  return [
    { key: 'ticket', header: content.tickets.columnTicket },
    { key: 'priority', header: content.tickets.columnPriority, isNarrow: true },
    { key: 'status', header: content.tickets.columnStatus, isNarrow: true },
    { key: 'assignee', header: content.tickets.columnAssignee },
    { key: 'opened', header: content.tickets.columnOpened, isNarrow: true },
  ];
}
