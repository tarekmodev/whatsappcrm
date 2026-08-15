import type { TicketListQuery } from '@whatsappcrm/contracts';

/**
 * Page sizes for the assignment surface, here rather than inline so a list, its
 * skeleton row count and its server query cannot disagree.
 */
export const FLAGGED_TICKETS_PAGE_SIZE = 25 satisfies TicketListQuery['limit'];

/**
 * Rows the flagged-ticket skeleton draws.
 *
 * Deliberately *not* `FLAGGED_TICKETS_PAGE_SIZE`: a healthy workspace has a
 * handful of stuck tickets, not twenty-five, so drawing a full page of
 * placeholders would collapse to three rows on arrival — a shift in the wrong
 * direction and a fright besides. Five is the count the section usually settles
 * at, and the empty state occupies a similar box.
 */
export const FLAGGED_TICKETS_SKELETON_COUNT = 5;
