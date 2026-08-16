import {
  TICKET_EVENT_TYPES,
  TicketEventCauseSchema,
  TicketEventTypeSchema,
  type TicketEvent,
  type TicketEventAssignment,
  type TicketEventCause,
  type TicketEventType,
} from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * `ticket_events` → `TicketEvent` (TAR-32, ADR 0011 decision 4).
 *
 * ## One shape out of five payloads
 *
 * `ticket_events.data` is JSONB and every writer has always shaped it for
 * itself: the linker writes `{ conversationId, cause }`, the rule engine
 * `{ reason, ruleId, assignedUserId, assignedTeamId }`, the sweep
 * `{ kind, dueAt }`, and `TicketCommandService` `{ from, to, cause }` or the
 * assignment quartet. None of that is a contract, and it must not become one:
 * this file is the single place that turns those payloads into the published
 * per-type encoding, so a console renders one shape rather than learning five.
 *
 * The encoding is the table in `TicketEventSchema`, and it is reproduced by the
 * `switch` below rather than described a second time.
 *
 * ## Reading JSONB defensively is the point, not caution
 *
 * There is no CHECK on `data` and no writer this module controls — the rule
 * engine and the SLA sweep are separate modules on separate paths. So every
 * field is read through a narrowing helper and a payload that does not carry it
 * yields `null`, which is exactly what an older row written before a key existed
 * looks like. The alternative — a cast — would put `undefined` into a response
 * the schema types as `string | null`.
 *
 * `assignment` is the one field derived from *two* halves of the payload, and
 * both halves are legitimately absent: the router only ever assigns a ticket
 * nobody holds, so its `assigned` rows carry no `previous*` pair and read as
 * `from: null` — which is true rather than missing.
 */

/** Every column the event read publishes, and nothing else. */
export const TICKET_EVENT_PROJECTION = {
  id: true,
  ticketId: true,
  type: true,
  actorUserId: true,
  data: true,
  createdAt: true,
} as const satisfies Prisma.TicketEventSelect;

export type TicketEventRow = Prisma.TicketEventGetPayload<{
  select: typeof TICKET_EVENT_PROJECTION;
}>;

/** The published shape of one row, per type. */
interface TicketEventPayload {
  readonly fromValue: string | null;
  readonly toValue: string | null;
  readonly assignment: TicketEventAssignment | null;
  readonly reason: string | null;
}

/**
 * The `data` key an `escalated` event carries its named supervisor under, and
 * the reason it is not `toUserId`: the assignment does **not** move (0011
 * decision 3), so a key that reads like one of the assignment columns would
 * invite exactly the confusion the separate event type exists to prevent.
 */
export const ESCALATED_TO_USER_ID = 'escalatedToUserId';

/**
 * The `where` fragment that confines a read to the types this build publishes.
 *
 * `ticket_events.type` is `text` with no constraint behind it — deliberately, so
 * a story can add a type without a migration — which means a row written by a
 * newer release than the one serving the read is a real possibility during a
 * rolling deploy. Filtering in the query rather than throwing in the mapper is
 * what keeps that a row a client cannot render yet instead of a 500 on the whole
 * page.
 *
 * It costs no index: `(tenant_id, ticket_id, created_at DESC, id DESC)` still
 * supplies the predicate and both sort keys, and this is a recheck on the rows
 * it returns — a set bounded by one ticket and one page.
 */
export const PUBLISHED_TICKET_EVENT_TYPES = {
  type: { in: [...TICKET_EVENT_TYPES] },
} as const satisfies Prisma.TicketEventWhereInput;

export function toTicketEventResponse(row: TicketEventRow): TicketEvent {
  const type = TicketEventTypeSchema.safeParse(row.type);

  if (!type.success) {
    // Unreachable through any query that spreads `PUBLISHED_TICKET_EVENT_TYPES`.
    // Stated as a throw rather than a cast so that a caller which forgets the
    // filter fails on the row it mis-read, naming it, instead of publishing an
    // event whose `type` the response schema refuses.
    throw new Error(`ticket event ${row.id} carries the unpublished type ${row.type}`);
  }

  const data = asRecord(row.data);

  return {
    id: row.id,
    ticketId: row.ticketId,
    type: type.data,
    actorUserId: row.actorUserId,
    ...payloadOf(type.data, data),
    cause: causeIn(data),
    createdAt: row.createdAt.toISOString(),
  };
}

function payloadOf(
  type: TicketEventType,
  data: Record<string, unknown> | null,
): TicketEventPayload {
  switch (type) {
    case 'status_changed':
    case 'priority_changed':
      return {
        fromValue: stringIn(data, 'from'),
        toValue: stringIn(data, 'to'),
        assignment: null,
        reason: null,
      };

    case 'assigned':
    case 'unassigned':
      return {
        fromValue: null,
        toValue: null,
        assignment: assignmentIn(data),
        reason: stringIn(data, 'reason'),
      };

    case 'escalated':
      // Null is meaningful here: the escalation was addressed to whoever
      // supervises this ticket rather than to a person, and a console renders
      // the two differently.
      return {
        fromValue: null,
        toValue: stringIn(data, ESCALATED_TO_USER_ID),
        assignment: null,
        reason: stringIn(data, 'reason'),
      };

    case 'assignment_deferred':
      // The `FallbackAssignmentReason` the router recorded — a machine token
      // rather than prose, but it is what "why is this ticket stuck" answers.
      return { fromValue: null, toValue: null, assignment: null, reason: stringIn(data, 'reason') };

    case 'sla_breached':
      return { fromValue: null, toValue: stringIn(data, 'kind'), assignment: null, reason: null };

    case 'created':
    case 'conversation_linked':
    case 'first_response':
    case 'reopened':
    case 'bot_handoff':
      // Types whose payload is context for the log rather than a published
      // field. Enumerated instead of a `default` so that adding a type to
      // `TICKET_EVENT_TYPES` fails to compile here until its encoding is
      // decided.
      return { fromValue: null, toValue: null, assignment: null, reason: null };
  }
}

/**
 * Both sides of an assignment change, from whichever halves the writer left.
 *
 * The new pair is `assignedUserId`/`assignedTeamId` — the columns as they were
 * written — and the old pair is the `previous*` fields `TicketCommandService`
 * adds because a supervisor's re-assignment is exactly the case where "who had
 * it before" is the interesting half.
 */
function assignmentIn(data: Record<string, unknown> | null): TicketEventAssignment {
  return {
    fromUserId: stringIn(data, 'previousAssignedUserId'),
    fromTeamId: stringIn(data, 'previousAssignedTeamId'),
    toUserId: stringIn(data, 'assignedUserId'),
    toTeamId: stringIn(data, 'assignedTeamId'),
  };
}

/**
 * The cause token, or `null` for the event types that predate it and for a
 * payload carrying something the contract does not publish.
 *
 * Parsed rather than trusted: `data` has no CHECK behind it, and publishing an
 * unknown token would put a value in the response its own schema refuses.
 */
function causeIn(data: Record<string, unknown> | null): TicketEventCause | null {
  const parsed = TicketEventCauseSchema.safeParse(data?.['cause']);

  return parsed.success ? parsed.data : null;
}

function stringIn(data: Record<string, unknown> | null, key: string): string | null {
  const value = data?.[key];

  return typeof value === 'string' ? value : null;
}

/**
 * The payload as an object, or `null` for JSON null, an array or a scalar.
 *
 * The three exclusions are what make the narrowing honest rather than a cast:
 * Prisma types `data` as `JsonValue`, which includes `null`, arrays and
 * primitives, and indexing any of those would answer `undefined` for every key
 * while looking like a successful read.
 */
function asRecord(data: Prisma.JsonValue | null): Record<string, unknown> | null {
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? data : null;
}
