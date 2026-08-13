import { IdSchema, TicketListQuerySchema } from '@whatsappcrm/contracts';
import type { TicketPriorityFilter, TicketScope, TicketStatusFilter } from '@/lib/routes';

/**
 * The queue's URL state, narrowed from untrusted query parameters.
 *
 * Every value is validated against the *contract's* own schema rather than cast,
 * so the console and the API agree on what a scope, a status and a priority are
 * — and a hand-edited URL falls back to the default view instead of reaching a
 * fetch as a malformed query.
 *
 * Extracted from the page so the page stays composition-only and so this is
 * testable without rendering a route.
 */

export interface TicketQueueParams {
  scope: TicketScope;
  /** `undefined` is the active queue (`open` and `pending`), the API's default. */
  status: TicketStatusFilter | undefined;
  priority: TicketPriorityFilter | undefined;
  /** Narrows to breached tickets — `TicketListQuery.breachedOnly` (TAR-26). */
  isOverdueOnly: boolean;
}

export function parseTicketQueueParams(raw: {
  scope: string | undefined;
  status: string | undefined;
  priority: string | undefined;
  overdue: string | undefined;
}): TicketQueueParams {
  return {
    scope: parseScope(raw.scope),
    status: parseStatus(raw.status),
    priority: parsePriority(raw.priority),
    isOverdueOnly: parseOverdue(raw.overdue),
  };
}

/**
 * Only the exact string `'true'` turns the filter on.
 *
 * Deliberately stricter than the contract's `z.coerce.boolean()`, which treats
 * every non-empty string as true — including `'false'`. A hand-edited or
 * truncated `?overdue=` must fall back to the full queue rather than silently
 * hiding every ticket that is on time.
 */
function parseOverdue(value: string | undefined): boolean {
  return value === 'true';
}

function parseScope(value: string | undefined): TicketScope {
  const parsed = TicketListQuerySchema.shape.scope.safeParse(value);

  return parsed.success ? parsed.data : 'assigned';
}

function parseStatus(value: string | undefined): TicketStatusFilter | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = TicketListQuerySchema.shape.status.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

function parsePriority(value: string | undefined): TicketPriorityFilter | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = TicketListQuerySchema.shape.priority.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

/**
 * A ticket id from the route segment, or `null`.
 *
 * Shape-checked rather than passed through: the API answers 422 for a path
 * parameter that is not a UUID, and an error card is the wrong answer for a
 * truncated link. Whether the id names a ticket this principal may see is the
 * API's decision, and it answers `not_found` — never `forbidden`.
 */
export function parseTicketId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  return IdSchema.safeParse(value).success ? value : null;
}
