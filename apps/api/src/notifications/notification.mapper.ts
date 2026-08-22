import {
  NOTIFICATION_TYPES,
  type NotificationResponse,
  type NotificationType,
} from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * `notifications` → `NotificationResponse`, across every published type.
 *
 * A projection constant and a pure function, the arrangement `sla-alert.mapper.ts`
 * and `escalation-alert.mapper.ts` already keep for their own single-type views
 * of the same table. This is the third and widest reader: the generalised inbox
 * 0009 decision 7 published, over the rows those two see one type of each.
 *
 * ## `ticketNumber` comes from the ticket, and that is not over-fetching
 *
 * The same trade the two type-specific mappers make and for the same reason: an
 * inbox row reading "ticket #412" rather than a UUID is what makes the list
 * usable without a call per row. One join on `(tenant_id, id)`, resolved once
 * per page. Nothing else is taken off the ticket — the wider list publishes no
 * assignment fields, so it does not read them.
 *
 * ## `data` is flattened here rather than published raw
 *
 * `message`, `workflowId` and `workflowRunId` live in an untyped JSONB blob
 * because the column is shared by types that carry different things (0009
 * decision 7). The contract publishes them as named nullable fields, so the
 * flattening happens once, here, rather than in every console that renders a
 * row. A value of the wrong shape reads as `null` rather than throwing: the
 * column has no CHECK behind it, so a malformed blob is a rendering problem and
 * not a reason to fail a supervisor's whole page.
 */
export const NOTIFICATION_PROJECTION = {
  id: true,
  type: true,
  ticketId: true,
  slaTimerId: true,
  dueAt: true,
  data: true,
  acknowledgedAt: true,
  createdAt: true,
  ticket: { select: { number: true } },
} as const satisfies Prisma.NotificationSelect;

/**
 * The `where` fragment that bounds this list to the types the contract publishes.
 *
 * `notification_type` carries a fourth label — `escalation`, added by TAR-468 —
 * which `NOTIFICATION_TYPES` deliberately does not, because an escalation has a
 * dedicated surface of its own in `GET /api/v1/escalation-alerts` and carries
 * two fields (`raisedByUserId`, `reason`) that `NotificationResponse` has no
 * home for. Publishing it here would either return a `type` no client has a
 * branch for or silently drop what makes the row readable.
 *
 * Stated as a filter rather than left to the mapper's guard so the exclusion is
 * one decision in one place, and so the query and the type agree.
 */
export const PUBLISHED_NOTIFICATION_TYPES_ONLY = {
  type: { in: [...NOTIFICATION_TYPES] },
} as const satisfies Prisma.NotificationWhereInput;

export type NotificationRow = Prisma.NotificationGetPayload<{
  select: typeof NOTIFICATION_PROJECTION;
}>;

export function toNotificationResponse(row: NotificationRow): NotificationResponse {
  if (!isPublishedType(row.type)) {
    // Unreachable through any query that spreads `PUBLISHED_NOTIFICATION_TYPES_ONLY`.
    // Stated as a throw rather than a cast so that a caller which forgets the
    // filter fails on the row it mis-read, naming the row, instead of answering
    // with a `type` the published enum does not contain.
    throw new Error(`notification ${row.id} carries the unpublished type ${row.type}`);
  }

  const data = readData(row.data);

  return {
    id: row.id,
    type: row.type,
    ticketId: row.ticketId,
    ticketNumber: row.ticket.number,
    slaTimerId: row.slaTimerId,
    dueAt: row.dueAt?.toISOString() ?? null,
    message: data.message,
    workflowId: data.workflowId,
    workflowRunId: data.workflowRunId,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The three named fields the contract flattens out of `data`, or nulls. */
function readData(data: Prisma.JsonValue | null): {
  message: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
} {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { message: null, workflowId: null, workflowRunId: null };
  }

  const payload = data as Record<string, unknown>;

  return {
    message: stringOrNull(payload['message']),
    workflowId: stringOrNull(payload['workflowId']),
    workflowRunId: stringOrNull(payload['workflowRunId']),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isPublishedType(type: string): type is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(type);
}
