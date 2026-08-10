import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { CursorPageQuerySchema } from './pagination';

/**
 * Helpdesk ticketing. TAR-21 creates tickets from conversations, TAR-25 owns
 * status and priority, TAR-26 attaches SLA timers, TAR-32 reads the event log.
 *
 * A ticket is a **unit of work on** a conversation, not a copy of it. One
 * conversation accumulates many tickets over its life; messages stay on the
 * conversation so the thread is never split across tickets.
 */

export const TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);

/**
 * `pending` means waiting on the customer, and that distinction is load-bearing:
 * SLA timers pause in `pending` and resume on the customer's next inbound
 * message (TAR-26). Treating it as just another open state would bill agents for
 * time they could not act on.
 */
export const TICKET_STATUS_PAUSES_SLA: Record<TicketStatus, boolean> = {
  open: false,
  pending: true,
  resolved: true,
  closed: true,
};

export const SLA_STATES = ['not_applicable', 'running', 'paused', 'met', 'breached'] as const;
export const SlaStateSchema = z.enum(SLA_STATES);

export const TicketSlaSchema = z.object({
  policyId: IdSchema.nullable(),
  firstResponseState: SlaStateSchema,
  firstResponseDueAt: TimestampSchema.nullable(),
  resolutionState: SlaStateSchema,
  resolutionDueAt: TimestampSchema.nullable(),
});

export const TicketResponseSchema = z.object({
  id: IdSchema,
  /** Per-tenant sequential number — what agents and customers actually quote. */
  number: z.int().positive(),
  conversationId: IdSchema,
  contactId: IdSchema,
  subject: z.string().min(1).max(200),
  status: TicketStatusSchema,
  priority: TicketPrioritySchema,
  assignedUserId: IdSchema.nullable(),
  assignedTeamId: IdSchema.nullable(),
  sla: TicketSlaSchema,
  firstRespondedAt: TimestampSchema.nullable(),
  resolvedAt: TimestampSchema.nullable(),
  closedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const TicketListQuerySchema = CursorPageQuerySchema.extend({
  status: TicketStatusSchema.optional(),
  priority: TicketPrioritySchema.optional(),
  scope: z.enum(['assigned', 'unassigned', 'all']).default('assigned'),
  assignedUserId: IdSchema.optional(),
  assignedTeamId: IdSchema.optional(),
  /** Filters to tickets whose SLA has breached — the supervisor's landing view. */
  breachedOnly: z.boolean().default(false),
});

export const TicketUpdateInputSchema = z.object({
  subject: z.string().min(1).max(200).optional(),
  status: TicketStatusSchema.optional(),
  priority: TicketPrioritySchema.optional(),
});

export const TicketAssignInputSchema = z
  .object({
    userId: IdSchema.nullable().optional(),
    teamId: IdSchema.nullable().optional(),
    /** Recorded on the event log; surfaced in the escalation history (TAR-32). */
    reason: z.string().max(500).optional(),
  })
  .refine((v) => v.userId !== undefined || v.teamId !== undefined, {
    message: 'Provide at least one of userId or teamId',
  });

/**
 * Append-only audit trail. Every status change, assignment and SLA event lands
 * here, which is what makes TAR-32's escalation log and TAR-30's cycle-time
 * reporting derivable rather than separately maintained.
 */
export const TICKET_EVENT_TYPES = [
  'created',
  'status_changed',
  'priority_changed',
  'assigned',
  'unassigned',
  'first_response',
  'sla_breached',
  'reopened',
  'bot_handoff',
] as const;
export const TicketEventTypeSchema = z.enum(TICKET_EVENT_TYPES);

export const TicketEventSchema = z.object({
  id: IdSchema,
  ticketId: IdSchema,
  type: TicketEventTypeSchema,
  /** Null when the actor was automation rather than a person. */
  actorUserId: IdSchema.nullable(),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: TimestampSchema,
});

export type TicketPriority = z.infer<typeof TicketPrioritySchema>;
export type SlaState = z.infer<typeof SlaStateSchema>;
export type TicketSla = z.infer<typeof TicketSlaSchema>;
export type TicketResponse = z.infer<typeof TicketResponseSchema>;
export type TicketListQuery = z.infer<typeof TicketListQuerySchema>;
export type TicketUpdateInput = z.infer<typeof TicketUpdateInputSchema>;
export type TicketAssignInput = z.infer<typeof TicketAssignInputSchema>;
export type TicketEventType = z.infer<typeof TicketEventTypeSchema>;
export type TicketEvent = z.infer<typeof TicketEventSchema>;
