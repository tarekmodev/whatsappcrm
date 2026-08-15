import 'server-only';

import type {
  FallbackAssignmentReason,
  TeamResponse,
  TicketResponse,
  UserResponse,
} from '@whatsappcrm/contracts';
import { listTickets } from '@/lib/api/tickets';
import { listTeams } from '@/lib/api/teams';
import { listUsers } from '@/lib/api/users';
import { AGENTS_PAGE_SIZE } from '@/features/people/constants';
import { FLAGGED_TICKETS_PAGE_SIZE } from './constants';

/**
 * The supervisor's flagged-ticket read: every ticket auto-assignment could not
 * place, plus the two lookups needed to render and act on one.
 *
 * ADR 0008's landing query — `routingState=deferred` is one indexed predicate,
 * not a new subsystem. Tenant scoping is the API's, from the session; there is no
 * tenant parameter here to get wrong.
 *
 * **Every narrowing this view offers goes into the query.** Nothing is filtered
 * out of the response afterwards, because a page is not a set: the API answers
 * with the first `FLAGGED_TICKETS_PAGE_SIZE` rows of whatever was asked for, so a
 * predicate applied after the fact describes the page and gets rendered as though
 * it described the queue.
 *
 * **And the answer is checked against the question.** `TicketListQuerySchema`
 * accepts `routingState`/`deferredReason`, but `TicketQueryService.list` does not
 * implement them yet — TAR-273 owes that predicate — and an unknown parameter is
 * dropped rather than refused. A dropped filter is invisible: the response parses,
 * so the queue would render the tenant's *active* tickets, find none of them
 * deferred, and report "Showing 0" directly above "Nothing is
 * stuck". `assertRoutingFilterHonoured` turns that into the error it is, so the
 * section says it is broken instead of quietly contradicting itself. It costs
 * nothing once the predicate lands: a response that matches the request passes it
 * in one pass and never throws.
 */

export interface FlaggedTicketsFilters {
  /** Omitted means every reason. Comes from `?reason=`, already narrowed. */
  deferredReason?: FallbackAssignmentReason;
}

export interface FlaggedTicketsReport {
  /**
   * The page the API returned, already narrowed by `filters`, in the API's order.
   *
   * Not re-sorted here. ADR 0008 wanted the flagged list oldest-stuck first, but
   * TAR-273 shipped it on the ticket queue's own `(priority, created_at, id)`;
   * re-sorting a *page* of that would reorder 25 rows chosen by a different key,
   * which is a different list rather than a better-sorted one.
   */
  tickets: readonly TicketResponse[];
  /**
   * True when the API had more matching tickets than fit on this page.
   *
   * The view has to say so out loud. Without it a truncated page is
   * indistinguishable from a complete one, and every count rendered beside it is
   * a claim about the whole queue that nobody checked.
   */
  hasMore: boolean;
  /** Active agents a supervisor may hand a ticket to. */
  assignableUsers: readonly UserResponse[];
  teams: readonly TeamResponse[];
}

export async function loadFlaggedTickets(
  filters: FlaggedTicketsFilters,
): Promise<FlaggedTicketsReport> {
  const [tickets, users, teams] = await Promise.all([
    listTickets({
      // `all`, not `unassigned`. TAR-286 fixed `unassigned` as "no user **and**
      // no team", which is right for the agent queue — but a ticket routed to a
      // team by rule and then deferred still carries `assignedTeamId`, and that
      // is exactly the `all_at_capacity` case this view exists to show.
      // `routingState=deferred` identifies the flagged set on its own; `scope`
      // only decides how wide the read is, and the API narrows it to the
      // caller's own work without `ticket:read_all` — which this section is
      // already gated on.
      scope: 'all',
      routingState: 'deferred',
      // The reason narrows the *query*, not the page it returned. Filtering
      // afterwards asks the database for the 25 oldest deferred tickets and then
      // hides most of them, so a reason whose tickets all sort past row 25 renders
      // "no tickets for that reason" while they sit in the table — and it does that
      // exactly when the queue is long, which is when this view gets opened.
      deferredReason: filters.deferredReason,
      limit: FLAGGED_TICKETS_PAGE_SIZE,
      breachedOnly: false,
    }),
    listUsers({ status: 'active', limit: AGENTS_PAGE_SIZE }),
    listTeams(),
  ]);

  assertRoutingFilterHonoured(tickets.items, filters);

  return {
    tickets: tickets.items,
    hasMore: tickets.nextCursor !== null,
    // Every *active* user, not only `role = 'agent'`. Rotation restricts its own
    // candidate pool to agents (ADR 0008 decision 1) so that supervisors are not
    // silently fed customer tickets — but this is the manual override, and the
    // remedy that decision names for `all_at_capacity` is "or take it yourself".
    // A picker that excluded the person clicking it would refuse the one action
    // the reason copy recommends.
    //
    // `invited` and `suspended` accounts *are* excluded, by the query above: the
    // API refuses an assignment to one, so offering it would be a control that
    // exists only to fail.
    assignableUsers: users.items,
    teams: teams.items,
  };
}

/**
 * Thrown when the API answered a different question from the one asked.
 *
 * Its own type rather than a bare `Error` so the cause is legible in a server log
 * and assertable in a test: this is not a network failure or a malformed payload,
 * it is a filter that was accepted and then ignored.
 */
export class RoutingFilterNotHonouredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingFilterNotHonouredError';
  }
}

/**
 * Every ticket the API returned has to actually match the filter it was asked
 * for. One pass, and it stops at the first row that does not.
 *
 * The failure this exists for is silent by construction: an API that does not
 * implement `routingState` drops it rather than refusing, so the response is a
 * *valid* page of the wrong set. Rendering it produces a queue that reports
 * nothing stuck and, in the same breath, that more is flagged than fits on a page.
 *
 * Throwing hands the section to its `SectionErrorBoundary`, which is the honest
 * outcome and the one this surface had before `TicketResponse.routing` became
 * required — the difference is that it is now deliberate and says why, rather
 * than falling out of a schema that happened to reject the payload.
 */
function assertRoutingFilterHonoured(
  tickets: readonly TicketResponse[],
  filters: FlaggedTicketsFilters,
): void {
  const mismatch = tickets.find(
    (ticket) =>
      ticket.routing.state !== 'deferred' ||
      (filters.deferredReason !== undefined &&
        ticket.routing.deferredReason !== filters.deferredReason),
  );

  if (mismatch !== undefined) {
    throw new RoutingFilterNotHonouredError(
      `The ticket list ignored routingState=deferred${
        filters.deferredReason === undefined ? '' : `&deferredReason=${filters.deferredReason}`
      }: ticket ${mismatch.id} came back as ${mismatch.routing.state}` +
        `${mismatch.routing.deferredReason === null ? '' : `/${mismatch.routing.deferredReason}`}. ` +
        'The flagged queue cannot be rendered from an unfiltered page.',
    );
  }
}
