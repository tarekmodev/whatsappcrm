import 'server-only';

import {
  TicketEscalationResponseSchema,
  TicketEventSchema,
  TicketResponseSchema,
  type CursorPage,
  type TicketAssignInput,
  type TicketEscalateInput,
  type TicketEscalationResponse,
  type TicketEvent,
  type TicketEventListQuery,
  type TicketListQuery,
  type TicketResponse,
  type TicketUpdateInput,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';
import { parseCursorPage } from '@/lib/api/parse';

/**
 * The ticket resource, per ADR 0006: the queue, one ticket, and the single PATCH
 * that changes its status, priority or subject.
 *
 * `POST /tickets` is deliberately absent and is not coming: tickets are opened by
 * the auto-linking pipeline when a customer writes in, never by an agent pressing
 * a button (ADR 0003). `assign` has since landed with TAR-23, below, and TAR-32
 * adds the two calls the handoff surface makes — `escalate` and the event log the
 * ticket resource has had reserved since TAR-25.
 */

const TICKETS_PATH = '/v1/tickets';

/**
 * `GET /api/v1/tickets`.
 *
 * **No sort parameter, and that is the contract.** The queue has exactly one
 * order — `priority DESC, createdAt DESC, id DESC`, urgent first — and it is the
 * API's. Nothing in the console re-sorts what comes back; a second copy of the
 * order here is how the list and the cursor would drift apart.
 *
 * Omitting `status` asks for the **active** queue (`open` and `pending`), which
 * is what makes a resolved ticket leave the list with no client change.
 */
export async function listTickets(query: TicketListQuery): Promise<CursorPage<TicketResponse>> {
  const params = new URLSearchParams({ scope: query.scope, limit: String(query.limit) });

  if (query.status !== undefined) {
    params.set('status', query.status);
  }

  if (query.priority !== undefined) {
    params.set('priority', query.priority);
  }

  if (query.assignedUserId !== undefined) {
    params.set('assignedUserId', query.assignedUserId);
  }

  if (query.assignedTeamId !== undefined) {
    params.set('assignedTeamId', query.assignedTeamId);
  }

  // The supervisor's flagged queue (TAR-23): `?routingState=deferred` is what
  // "auto-assignment could not place this" means on the wire, per ADR 0008.
  if (query.routingState !== undefined) {
    params.set('routingState', query.routingState);
  }

  // Narrowed by the *query*, never by the page it returned: filtering afterwards
  // asks for the oldest deferred tickets and then hides most of them, so a reason
  // whose tickets all sort past the page renders as "none of those" while they
  // sit in the queue.
  if (query.deferredReason !== undefined) {
    params.set('deferredReason', query.deferredReason);
  }

  if (query.breachedOnly) {
    params.set('breachedOnly', 'true');
  }

  const response = await authenticatedRequest({
    method: 'GET',
    path: `${TICKETS_PATH}?${params.toString()}`,
  });

  return parseCursorPage(TicketResponseSchema, response);
}

/**
 * `GET /api/v1/tickets/{id}`.
 *
 * A ticket the caller may not see answers `not_found`, never `forbidden` — a 403
 * would confirm the id names a real ticket a colleague is working.
 */
export async function getTicket(ticketId: string): Promise<TicketResponse> {
  const response = await authenticatedRequest({
    method: 'GET',
    path: `${TICKETS_PATH}/${ticketId}`,
  });

  return TicketResponseSchema.parse(response);
}

/**
 * `PATCH /api/v1/tickets/{id}` — status, priority and subject in one call.
 *
 * One endpoint rather than a `/status` sub-route, because unlike a conversation
 * status a ticket's status and priority are one triage decision an agent makes in
 * one action (ADR 0006 §1).
 *
 * Two refusals the caller has to be ready for, and neither is an edge case:
 * `conflict` when the row moved under the agent — a customer replying to a
 * `pending` ticket reopens it, and the compare-and-set then matches nothing — and
 * `forbidden` when a terminal transition is attempted without `ticket:close`.
 */
export async function updateTicket(
  ticketId: string,
  input: TicketUpdateInput,
): Promise<TicketResponse> {
  const response = await authenticatedRequest({
    method: 'PATCH',
    path: `${TICKETS_PATH}/${ticketId}`,
    body: input,
  });

  return TicketResponseSchema.parse(response);
}

/**
 * `POST /api/v1/tickets/{id}/assign` — the supervisor's manual placement (TAR-23),
 * and the one the doc block above reserved for this story.
 *
 * Writes blind, like the conversation assign it mirrors: this is how somebody
 * takes a ticket nobody could be given and puts a name on it. The API
 * additionally moves `routing.state` to `manual`, which is what stops a later
 * routing pass overruling the decision.
 *
 * Also the **reassignment** surface (TAR-32, ADR 0011 decision 1): one route
 * rather than a second `/reassign`, because the two writes are the same
 * transaction over the same columns. `reason` becomes required exactly when the
 * ticket already has a holder — `ticketAssignRequiresReason` is the predicate
 * both halves read — and a missing one comes back as `validation_failed` from
 * the service rather than from the schema, because Zod sees the body and the
 * rule is about the row.
 */
export async function assignTicket(
  ticketId: string,
  input: TicketAssignInput,
): Promise<TicketResponse> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: `${TICKETS_PATH}/${encodeURIComponent(ticketId)}/assign`,
    body: input,
  });

  return TicketResponseSchema.parse(response);
}

/**
 * `POST /api/v1/tickets/{id}/escalate` — ask a supervisor to look (TAR-32).
 *
 * **The ticket does not change hands.** An escalation that un-assigned the agent
 * would leave the customer with nobody while the supervisor sleeps, and would
 * make "escalate" the one button that loses your work (ADR 0011 decision 3).
 *
 * The response is not a `TicketResponse` for exactly that reason — nothing on
 * the ticket moved. It carries the audit entry and who was told, and an empty
 * `notifiedUserIds` is a real outcome the caller has to render: a tenant with no
 * active supervisor still gets the escalation recorded.
 */
export async function escalateTicket(
  ticketId: string,
  input: TicketEscalateInput,
): Promise<TicketEscalationResponse> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: `${TICKETS_PATH}/${encodeURIComponent(ticketId)}/escalate`,
    body: input,
  });

  return TicketEscalationResponseSchema.parse(response);
}

/**
 * `GET /api/v1/tickets/{id}/events` — the ticket's append-only history, newest
 * first, and the read that makes reassignment and escalation visible at all.
 *
 * `ticket:read`, and the ticket goes through the same visibility rule the GET
 * does: a ticket the caller may not open answers `not_found` here too, so the
 * event log cannot become a side channel onto one.
 */
export async function listTicketEvents(
  ticketId: string,
  query: TicketEventListQuery,
): Promise<CursorPage<TicketEvent>> {
  const params = new URLSearchParams({ limit: String(query.limit) });

  if (query.cursor !== undefined) {
    params.set('cursor', query.cursor);
  }

  const response = await authenticatedRequest({
    method: 'GET',
    path: `${TICKETS_PATH}/${encodeURIComponent(ticketId)}/events?${params.toString()}`,
  });

  return parseCursorPage(TicketEventSchema, response);
}
