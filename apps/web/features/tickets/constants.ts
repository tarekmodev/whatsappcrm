import type { TicketEventListQuery, TicketListQuery } from '@whatsappcrm/contracts';

/**
 * The queue's page size, named once so the table, its skeleton's row count and
 * the server query cannot disagree — a skeleton drawing ten rows for a page of
 * twenty-five is a layout shift waiting to happen.
 */
export const TICKETS_PAGE_SIZE = 25 satisfies TicketListQuery['limit'];

/**
 * How much of a ticket's history the panel asks for, and how many placeholder
 * rows its skeleton draws.
 *
 * Smaller than the queue's page deliberately: this is one ticket's trail read
 * top-down, not a list somebody scans, and twenty-five rows of it would push the
 * controls above off a phone screen. The API pages on a keyset, so "older
 * entries are not shown" is the honest thing to say rather than a total the
 * console would have to page the whole log to know.
 */
export const TICKET_HISTORY_PAGE_SIZE = 10 satisfies TicketEventListQuery['limit'];

/**
 * The floor and ceiling `TicketAssignInputSchema` and `TicketEscalateInputSchema`
 * both put on `reason`, mirrored here so the form can refuse a value *before*
 * submitting rather than round-tripping to be told.
 *
 * Read from one place rather than typed into two dialogs: a client bound that
 * drifted from the contract's is a form that refuses what the API accepts, or
 * offers what it will not.
 */
export const TICKET_REASON_LIMITS = { minLength: 3, maxLength: 500 } as const;
