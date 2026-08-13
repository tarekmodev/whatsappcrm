import type { TicketListQuery } from '@whatsappcrm/contracts';

/**
 * The queue's page size, named once so the table, its skeleton's row count and
 * the server query cannot disagree — a skeleton drawing ten rows for a page of
 * twenty-five is a layout shift waiting to happen.
 */
export const TICKETS_PAGE_SIZE = 25 satisfies TicketListQuery['limit'];
