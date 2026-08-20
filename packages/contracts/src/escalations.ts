import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { CursorPageQuerySchema } from './pagination';

/**
 * The supervisor's side of an escalation (TAR-32, ADR 0011 decision 5).
 *
 * `POST /tickets/{id}/escalate` writes one `escalated` `ticket_events` row and
 * one alert per recipient. **The row is the record and the socket is the
 * immediacy**: a supervisor offline when the escalation fired sees it on their
 * next list read, which is what makes "the supervisor is notified" true rather
 * than "a message was emitted".
 *
 * ## The alert lives in `notifications`, and that is not a contract change
 *
 * 0011 decision 5 specified a parallel `escalation_alerts` table and named the
 * *third* notification type as the trigger to fold the alert tables into the
 * generic one 0006 predicted. TAR-394 reached that point first, at the second
 * type, so TAR-468 shipped escalation as `notifications.type = 'escalation'`
 * (0011 amendment 1). Every shape below is 0011's Interfaces section verbatim —
 * the storage moved, the published surface did not.
 */

/**
 * One escalation as the supervisor it was addressed to reads it.
 *
 * `raisedByUserId` and `reason` are read off the `escalated` event this alert
 * belongs to, so a supervisor's list renders without a second call per row —
 * the same call `SlaAlertResponse` makes with `ticketNumber` and the ticket's
 * assignment.
 *
 * `recipientUserId` is deliberately **absent**: the list is already narrowed to
 * the calling principal, so the field would restate the caller's own id on every
 * row. The realtime relay is the one consumer that needs it, because it is
 * addressing somebody else's room, and it selects the column itself.
 */
export const EscalationAlertResponseSchema = z.object({
  id: IdSchema,
  ticketId: IdSchema,
  /** Per-tenant sequential number — what agents and supervisors actually quote. */
  ticketNumber: z.int().positive(),
  /**
   * The `escalated` event this alert belongs to. **The group key**: N recipient
   * rows point at one escalation act, so a console shows one escalation and not
   * three.
   */
  ticketEventId: IdSchema,
  /** Who asked for help. Never null: neither escalation route is reachable without a principal. */
  raisedByUserId: IdSchema,
  reason: z.string(),
  /**
   * The ticket's **current** assignment, read off the alert's ticket at list
   * time — not a snapshot of who held it when the escalation fired. A ticket
   * reassigned since reads as it stands now, and deliberately: the supervisor
   * opens an unacknowledged escalation to act on it, and the only holder that
   * can be acted on is the one in force now. Who held it at that instant is
   * reconstructable from the ticket's `assigned` / `unassigned` events — the
   * alert is the work item, `ticket_events` is the record (0011 amendment 2).
   */
  assignedUserId: IdSchema.nullable(),
  assignedTeamId: IdSchema.nullable(),
  acknowledgedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});

/**
 * `unacknowledgedOnly` is `z.stringbool()` rather than `z.boolean()`, for the
 * reason `SlaAlertListQuerySchema` documents at length: this parses a **query
 * string**, `?unacknowledgedOnly=false` arrives as five characters, and
 * `z.coerce.boolean()` would turn the filter *on* for exactly the value a client
 * sends to widen the list.
 */
export const EscalationAlertListQuerySchema = CursorPageQuerySchema.extend({
  /** Default true: the supervisor's landing view is what still needs attention. */
  unacknowledgedOnly: z.stringbool().default(true),
});

export type EscalationAlertResponse = z.infer<typeof EscalationAlertResponseSchema>;
export type EscalationAlertListQuery = z.infer<typeof EscalationAlertListQuerySchema>;
