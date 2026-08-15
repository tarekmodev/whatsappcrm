# Manual reassignment and escalation (TAR-467)

Status: proposed · Builds on [0002 — architecture and API contract](./0002-architecture-and-api-contract.md), [0004 — RBAC permission matrix](./0004-rbac-permission-matrix.md), [0006 — SLA timers and supervisor alerts](./0006-sla-timers-and-supervisor-alerts.md), [0008 — assignment rotation and workload](./0008-assignment-rotation-and-workload.md) · Consumed by TAR-468 (schema), TAR-469 (backend), TAR-470 (frontend), TAR-471 (QA), TAR-473 (documentation)

> **Read 0006 decision 4 and 0008 decision 3 first.** This document reuses the recipient rule from
> the first and the assignment write from the second. Where it could disagree with either, they win:
> both shipped, and this story is additive to what they built.

## Context and Problem

TAR-32 asks for two behaviours:

> Given an agent reassigns a ticket to a teammate, when they do, then a reason is required and
> logged on the ticket's history.
>
> Given a ticket is escalated to a supervisor, when it happens, then the supervisor is notified and
> the escalation appears in the ticket's audit trail.

Most of the machinery already exists, and the design problem is almost entirely about **not
duplicating it**:

1. **`POST /api/v1/tickets/{id}/assign` already ships** (TAR-374, ruled by 0008 decision 3). It moves
   the four assignment and routing columns in one transaction, appends an `assigned` / `unassigned`
   event carrying `previousAssignedUserId` / `previousAssignedTeamId`, and already accepts an
   **optional** `reason` — `TicketAssignInputSchema` calls it "surfaced in the escalation history
   (TAR-32)".
2. **`ticket:assign` is supervisor-and-above** (0004). The story's actor is an **agent**, and an agent
   holds no permission that lets them move a ticket at all today.
3. **`ticket_events` already is the per-ticket history.** `TicketCommandService` states the rule this
   document inherits verbatim: ordinary triage is not written to `audit_logs`, because a trail an
   auditor reads must not be drowned by activity that happens hundreds of times a day per tenant.
   "The ticket's audit trail" in TAR-32's second criterion means `ticket_events`.
4. **`GET /api/v1/tickets/{id}/events` is published in 0002's endpoint table and implemented by
   nothing.** `tickets.controller.ts` and `docs/reference/tickets-api.md` both name TAR-32 as its
   owner. `TicketEventSchema` already publishes the wire shape.
5. **A durable supervisor notification already exists in one shape** — `sla_alerts`, one row per
   recipient, plus a `sla.breached` realtime emit to `userRoom(recipientUserId)`. 0006 decision 5
   rejected a general `notifications` table and said, in as many words, that when the second
   notification type arrives, generalising is the move to consider.
6. **RLS is the only tenant binding point** (0002 decision 1). Nothing here adds a second.

So the open questions are narrow, and there are five: **who may hand a ticket over**, **how a required
reason coexists with a shipped endpoint whose reason is optional**, **whether escalating moves the
ticket**, **where the supervisor's notification is durably recorded**, and **how `ticket_events.data`
becomes the flat `TicketEvent` the contract already publishes**.

## Goals / Non-Goals

**Goals**

- An agent can hand a ticket they hold to a teammate or a team, with a reason that cannot be omitted.
- An agent can raise a ticket to a supervisor with a reason, and that supervisor learns about it even
  if they are offline when it happens.
- Both actions land in one readable per-ticket history, structurally consistent with the events the
  router, the linker and the SLA sweep already write.
- Every shape TAR-468, TAR-469 and TAR-470 need is fixed here, precisely enough that the frontend can
  mock against it before the backend exists.
- Tenant scoping stated once, per surface, with the failure answer named.

**Non-Goals**

- Implementing any of it.
- Changing what `POST /tickets/{id}/assign` does. It is a shipped contract with a shipped console
  behind it; this document adds beside it and does not amend it.
- A general notification centre. 0006 decision 5 rejected one and its reasoning is unchanged: a
  taxonomy, per-type preferences and a read-state model are their own story.
- Escalation to anything outside the platform (TAR-32 out-of-scope), including email or WhatsApp
  notification of a supervisor.
- A manager or reporting-line model. 0006 decision 4 rejected `users.manager_user_id` and this reuses
  the derived rule rather than reopening it.
- Reopening `audit_logs` for ticket activity.

## Decisions

### Decision 1 — A second route, not a widened `assign`

**Trade-off axis: one endpoint that means two things vs. two endpoints that write the same columns.**

**Chosen — keep `POST /api/v1/tickets/{id}/assign` exactly as it is, and add
`POST /api/v1/tickets/{id}/handoff`.**

|                        | `POST /tickets/{id}/assign` (shipped) | `POST /tickets/{id}/handoff` (new)            |
| ---------------------- | ------------------------------------- | --------------------------------------------- |
| Actor                  | Supervisor placing work               | An agent passing on work they hold            |
| Permission             | `ticket:assign`                       | `ticket:handoff`                              |
| `reason`               | Optional                              | **Required**, 1–500 characters after trimming |
| May target             | Anyone in the tenant, or nobody       | Anyone in the tenant; never nobody            |
| May release the ticket | Yes (`null` clears)                   | No                                            |
| Bound                  | None beyond visibility                | Caller must currently hold the ticket         |

Both routes funnel into the **same private writer** in `TicketCommandService` — the transaction that
moves `assigned_user_id`, `assigned_team_id`, `routing_state`, `routing_deferred_reason`,
`routing_deferred_since` and appends one event. Two HTTP faces, one write. That is the property to
review: a second copy of that transaction is how the `tickets_routing_deferred_consistent` CHECK gets
violated by the newer path six months from now.

**Rejected — require `reason` on `/assign` and grant agents `ticket:assign`.** It is the smaller diff
and it is wrong twice. Requiring the field breaks a shipped request shape and the console typed
against it, for a route whose caller is a supervisor emptying the deferred queue — where "Assigned by
supervisor" is the only honest reason and forcing it to be typed is friction with no reader. Granting
agents `ticket:assign` hands every agent the right to take a ticket **off** a colleague, which is
exactly the split 0004 made deliberately for conversations.

**Rejected — a `reassign` sub-route name.** `/reassign` reads as a superset of `/assign` when it is
in fact the narrower right, and `ticket:reassign` beside `ticket:assign` would invite the next reader
to assume the wrong containment. `handoff` names the act and cannot be confused with it. The
**user-facing word stays "reassign"** — that is `apps/web/content/en.ts`'s business, not the URL's.

### Decision 2 — Two new permissions, held by every role

**Chosen — add `ticket:handoff` and `ticket:escalate` to `PERMISSIONS`, and to
`AGENT_PERMISSIONS`** (so supervisor and admin inherit them).

This is `conversation:claim`'s pattern applied a second time, and `rbac.ts` already argues it: a
narrow right every role holds, **bounded by the route rather than by the permission**, because a
permission cannot express "only while you are the one holding it". The alternative — one wide
`ticket:assign` for everybody — was rejected in decision 1.

Neither permission widens what anyone can _see_: both routes run behind the same visibility check as
`GET /tickets/{id}`, so a ticket the caller may not read is `not_found` on both.

**Rejected — no new permission, gate on `ticket:update`.** `ticket:update` is "re-prioritise and
resolve"; overloading it would mean a tenant cannot ever separate the two, and 0004's whole shape is
that a guard names the act.

### Decision 3 — The handoff bound is checked in the service, and refused with `forbidden`

**Chosen — `TicketCommandService.handOff` refuses unless the caller either holds `ticket:assign`, or
is the ticket's current holder.** "Current holder" is:

- `assigned_user_id = principal.userId`; **or**
- `assigned_user_id IS NULL` **and** the principal is a member of `assigned_team_id`.

An unassigned ticket cannot be handed off by an agent at all — there is nothing to hand off, and
taking it is `POST /tickets/{id}/assign` (supervisor) or rotation's job. A caller holding
`ticket:assign` is admitted so the console never has to branch on role before choosing a route.

The guard cannot do this: it is a property of the row, not of the route. It answers **`forbidden`,
not `not_found`** — by the time it is raised the caller has passed the visibility check, so the
ticket's existence is not a secret from them; what is refused is the act. This is exactly the
`ticket:close` mapping `tickets.http.ts` already documents, and the same paragraph explains why
answering `not_found` here would send an agent hunting for a ticket they are looking at.

### Decision 4 — Escalation notifies. It does not move the ticket

**Trade-off axis: "get me help" vs. "take this from me".**

**Chosen — `POST /tickets/{id}/escalate` writes an event, notifies supervisors, and leaves
`assigned_user_id` and `assigned_team_id` untouched.**

TAR-32's second criterion is "the supervisor is notified and the escalation appears in the ticket's
audit trail" — it does not say the ticket changes hands, and the two are genuinely different asks. An
agent who escalates usually still owns the customer and is still answering them; making escalation
also a release would force them to choose between asking for help and keeping the thread they are
mid-conversation on.

A supervisor who decides to take it uses `POST /tickets/{id}/assign`, which appends its own
`assigned` event. Two events is the honest history: somebody asked for help, and then somebody took
the ticket. One combined event would make the second indistinguishable from the first.

**Rejected — escalate as assign-to-supervisor.** Fewer round trips for the case where the supervisor
does take over, and wrong for every other case. It also forces the endpoint to name exactly one
supervisor, which decision 6 shows is the assumption this platform's role model cannot make.

### Decision 5 — The notification record is a new `ticket_escalations` table, one row per recipient

**Trade-off axis: generalise the shipped alert table vs. a second table beside it.**

**Chosen — a new table, shaped exactly like `sla_alerts` and anchored on the `ticket_events` row that
recorded the escalation.**

One row per (escalation, recipient). The row is the record — it survives a restart, a missed socket
and a supervisor who was asleep — and the realtime emit is the immediacy on top, which is 0006
decision 5's rule applied unchanged.

`reason` and `escalated_by_user_id` are denormalised onto every row rather than joined from the
event. Copying a 500-character string across the two or three recipients of an escalation is not a
cost worth a join on the one query a supervisor runs constantly, and it matches `sla_alerts`
denormalising `kind` and `due_at` "so the supervisor's list needs no join".

**Idempotency is `UNIQUE (tenant_id, ticket_event_id, recipient_user_id)`** — the event id plays the
role `sla_timer_id` plays in `sla_alerts`. A retry of the same escalation inserts nothing.

**Rejected — generalise `sla_alerts` into `ticket_alerts` with a `source` discriminator.** 0006
anticipated this and it is still the right _eventual_ shape, but not at this size: `sla_timer_id` is
`NOT NULL` and is half the unique key, so generalising means making it nullable, replacing the unique
index with a partial one per source, renaming the table, the Prisma model, `SlaAlertService`, the
contracts module, `GET /api/v1/sla-alerts` and the console surface reading it — a shipped,
supervisor-facing surface rewritten under a story whose whole backend budget is one day. Two tables
with the same shape is the cost; the rename stays available and gets cheaper once both readers exist
and their real query patterns are known. **Revisit when a third notification type arrives.**

**Rejected — realtime only, no row.** 0006 already rejected it in these words: a supervisor offline at
02:14 never learns, and the acceptance criterion is "the supervisor is notified", not "a message was
emitted".

### Decision 6 — Recipients: a named supervisor, or 0006's derived set

**Chosen — `toUserId` is optional. When present it names one recipient; when absent, recipients are
`resolveAlertRecipients(candidates, responsibility)` — the shipped pure function from 0006 decision 4.**

The derived rule is: active users with `role IN ('supervisor','admin')`, narrowed to those sharing a
team with whoever holds the ticket, falling back to all candidates when that yields nobody. It exists,
it is unit-tested without a database, and re-deriving a second recipient rule for the same
"tell a supervisor" problem is how two answers to one question get shipped.

`toUserId` must name an **active** user of this tenant whose role is `supervisor` or `admin`. It is
read through `TenantPrisma`, so another tenant's id simply is not there. A failure is
`validation_failed` on path `toUserId`, never `not_found` — the ticket was found; a field of the body
is wrong, which is the rule `UnknownTicketAssigneeError` already established.

**A tenant with no eligible recipient at all is refused with `conflict`**, not accepted with an empty
recipient list. This is the one place this document deviates from 0006, deliberately: the sweep logs a
warning and moves on because nobody is waiting on it, whereas an agent who pressed **Escalate** and
got a 201 would believe help was coming. The message names the condition — the tenant has no active
supervisor or admin.

### Decision 7 — `tickets.escalated_at`: the event says it happened, the column says it is findable

**Chosen — add `escalated_at timestamptz NULL` to `tickets`, written on every escalation, never
cleared. Add `escalatedOnly` to `TicketListQuerySchema`, beside the `breachedOnly` that already
exists.**

Same reasoning 0007 gives for `routing_state` beside the `assignment_deferred` event, and 0008 gives
for the flagged queue: an event records that something happened, and an event is not something a list
view can filter on. Without the column, "show me escalated tickets" is a join against
`ticket_events` on a text `type` for every page of the queue.

**It is not cleared, and the name says why**: it is "when this was last escalated", not "is
escalated". What a supervisor acts on is their own unacknowledged rows —
`GET /api/v1/escalations?acknowledged=false` — and what makes the ticket queue useful is
`escalatedOnly=true` combined with the active statuses the queue already defaults to. A cleared flag
would need an owner for the clearing, and neither resolving nor reassigning is obviously it.

**Index:** TAR-468 owns the shape. The predicate is `tenant_id = … AND escalated_at IS NOT NULL`
combined with the queue's existing `ORDER BY priority DESC, created_at DESC, id DESC`; a partial index
mirroring `ticket_active_queue` is the expected answer, and the same caveat applies — Prisma's
describer skips predicated indexes, so it belongs in the migration with an integration test that
fails if it goes missing.

### Decision 8 — `GET /tickets/{id}/events` publishes the flat shape, plus two type discriminators

**Chosen — implement the published `TicketEventSchema` as a projection of `ticket_events.data`, and
amend it with `fromType` / `toType`.**

The stored `data` is per-type JSON; the published wire shape is flat `fromValue` / `toValue` /
`reason` / `cause`. That is right — a client should not learn a JSON dialect per event type — but as
published it is **ambiguous for exactly the events this story is about**: `assigned` collapses a user
id and a team id into one nullable string, so a console cannot render "reassigned to the Billing
team" without guessing which it got.

The amendment is two nullable fields, `'user' | 'team' | 'status' | 'priority' | 'conversation' |
'sla_target' | null`. It is additive to a schema no endpoint has ever served, so no shipped consumer
moves.

**Rejected — publish `data` raw.** It makes the storage shape the wire shape, freezes every producer's
internal payload into the contract, and hands each consumer a `switch` over `type` before it can read
a field.

**The mapping, which TAR-469 implements and TAR-471 asserts:**

| `type`                    | `fromValue` / `fromType`                                                      | `toValue` / `toType`                                          | `reason`              | `cause`              |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------- | -------------------- |
| `created`                 | `null`                                                                        | `data.conversationId` / `conversation`                        | `null`                | `data.cause`         |
| `conversation_linked`     | `null`                                                                        | `data.conversationId` / `conversation`                        | `null`                | `data.cause ?? null` |
| `status_changed`          | `data.from` / `status`                                                        | `data.to` / `status`                                          | `null`                | `data.cause`         |
| `priority_changed`        | `data.from` / `priority`                                                      | `data.to` / `priority`                                        | `null`                | `data.cause`         |
| `assigned`                | `data.previousAssignedUserId ?? data.previousAssignedTeamId` / `user`\|`team` | `data.assignedUserId ?? data.assignedTeamId` / `user`\|`team` | `data.reason ?? null` | `data.cause ?? null` |
| `unassigned`              | same as `assigned`                                                            | `null`                                                        | `data.reason ?? null` | `data.cause ?? null` |
| `assignment_deferred`     | `null`                                                                        | `null`                                                        | `data.reason`         | `automation`         |
| `first_response`          | `null`                                                                        | `null`                                                        | `null`                | `null`               |
| `sla_breached`            | `null`                                                                        | `data.kind` / `sla_target`                                    | `null`                | `sla`                |
| **`escalated`** (new)     | `data.previousAssignedUserId` / `user`                                        | `data.toUserId` / `user`                                      | `data.reason`         | `agent`              |
| `reopened`, `bot_handoff` | per their owning story                                                        |                                                               |                       |                      |

Three rules the implementation must not soften:

- **A `null` from a producer that predates a field stays `null`.** `cause` is already documented as
  nullable for exactly this reason; no default may be invented in the mapper, because a fabricated
  `agent` on a row a queue worker wrote is a lie in the history.
- **`data.reason` is passed through unmodified and is never parsed.** It is agent free text.
  `TICKET_EVENT_CAUSES` exists so no consumer ever string-matches prose — the rule `tickets.ts`
  already states.
- **An unknown `type` is served, not dropped.** `ticket_events.type` is text precisely so later
  stories add types without a migration; a reader that filters to a known set would silently hide
  history. Unknown types map to all-null values with their `type` intact. TAR-470 renders an unknown
  type as a neutral "activity" row rather than nothing.

### Decision 9 — `escalated` is a new event type, not a `status_changed` variant

**Chosen — add `'escalated'` to `TICKET_EVENT_TYPES`.** No migration: `ticket_events.type` is text
for this purpose. It is a distinct thing that happened, with no `from`/`to` on the ticket's own state,
and folding it into an existing type would make TAR-30's cycle-time derivation learn to ignore it.

`cause` is `'agent'`. `TICKET_EVENT_CAUSES` needs no new member: an escalation is always a person's
act, and a future automated escalation would carry `automation`, which already exists.

## Decisions in brief

| Concern              | Choice                                                           | Alternatives considered                                 | Rationale                                                                                           |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Agent reassignment   | New `POST /tickets/{id}/handoff` beside the shipped `/assign`    | Require `reason` on `/assign` and widen `ticket:assign` | Does not break a shipped contract; does not give every agent the right to take work off a colleague |
| Permissions          | `ticket:handoff`, `ticket:escalate` on every role                | Reuse `ticket:assign`; reuse `ticket:update`            | `conversation:claim`'s pattern: a narrow right, bounded by the route                                |
| Handoff bound        | Service check: caller holds the ticket, or holds `ticket:assign` | Guard-level check                                       | A guard cannot read the row; refused `forbidden`, as `ticket:close` already is                      |
| Escalation semantics | Notify only; assignment untouched                                | Assign to a supervisor                                  | The criterion says "notified", and asking for help should not cost the thread                       |
| Notification record  | New `ticket_escalations`, one row per recipient                  | Generalise `sla_alerts`; realtime only                  | Survives an offline supervisor; avoids rewriting a shipped supervisor surface under a 1-day story   |
| Recipients           | Named `toUserId`, else 0006's `resolveAlertRecipients`           | A manager column; tenant-wide broadcast                 | Reuses a shipped, unit-tested rule; no reporting-line model to build                                |
| Findability          | `tickets.escalated_at` + `escalatedOnly` filter                  | Query `ticket_events` per page                          | An event is not something a list view can filter on                                                 |
| Event read           | Flat `TicketEvent` + `fromType`/`toType`                         | Publish `data` raw                                      | One wire shape; no per-type JSON dialect for clients                                                |

## Data model

Owned by **TAR-468**. Three deltas.

**1. New table `ticket_escalations`**

```prisma
/// One row per supervisor told about one escalation (TAR-32, 0011 decision 5).
/// Shaped after `sla_alerts`: the row is the durable record, the realtime emit
/// is the immediacy on top.
model TicketEscalation {
  id                String    @id @default(uuid(7)) @db.Uuid
  tenantId          String    @map("tenant_id") @db.Uuid
  ticketId          String    @map("ticket_id") @db.Uuid
  /// The `ticket_events` row that recorded the escalation. The idempotency
  /// anchor, playing the part `sla_timer_id` plays in `sla_alerts`.
  ticketEventId     String    @map("ticket_event_id") @db.Uuid
  recipientUserId   String    @map("recipient_user_id") @db.Uuid
  /// Denormalised so the supervisor's list needs no join, and so a later edit
  /// of anything cannot rewrite what the supervisor was told.
  escalatedByUserId String    @map("escalated_by_user_id") @db.Uuid
  reason            String    @db.VarChar(500)
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  /// Set by `POST /api/v1/escalations/{id}/acknowledge`. First write wins; a
  /// second call is not a conflict.
  acknowledgedAt    DateTime? @map("acknowledged_at") @db.Timestamptz(3)

  tenant      Tenant      @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  ticket      Ticket      @relation(fields: [tenantId, ticketId], references: [tenantId, id], onDelete: Cascade)
  ticketEvent TicketEvent @relation(fields: [tenantId, ticketEventId], references: [tenantId, id], onDelete: Cascade)
  /// `NoAction` on both user references, matching every other user reference in
  /// the file: removing a user is a status change, never a row delete.
  recipient   User        @relation("EscalationRecipient", fields: [tenantId, recipientUserId], references: [tenantId, id], onDelete: NoAction, onUpdate: NoAction)
  escalatedBy User        @relation("EscalationActor", fields: [tenantId, escalatedByUserId], references: [tenantId, id], onDelete: NoAction, onUpdate: NoAction)

  @@unique([tenantId, ticketEventId, recipientUserId])
  @@index([tenantId, recipientUserId, createdAt(sort: Desc), id(sort: Desc)])
  @@index([tenantId, ticketId])
  @@map("ticket_escalations")
}
```

RLS: the same tenant policy every table in this schema carries. The migration adds it; a table without
one is the isolation hole 0002 decision 1 exists to prevent, and the tenancy integration test is what
catches its absence.

**2. `TicketEvent` gains `@@unique([tenantId, id])`.** It has none today, and the composite foreign key
above cannot exist without it. It is the same shape `Ticket` already carries for the same reason.

**3. `tickets.escalated_at timestamptz NULL`**, plus the index for decision 7.

**Nothing is added to `audit_logs` and no `AUDIT_ACTIONS` member is added.** An escalation is
operational activity on a ticket, not a security-relevant change to the tenant's configuration —
`ticket_events` is the trail TAR-32's second criterion names.

## Interfaces

Owned by **TAR-469** (`packages/contracts`), consumed by **TAR-470**.

```ts
// packages/contracts/src/tickets.ts

/** Trimmed before validation: "   " is not a reason. */
export const HandoffReasonSchema = z.string().trim().min(1).max(500);

export const TicketHandoffInputSchema = z
  .object({
    userId: IdSchema.optional(),
    teamId: IdSchema.optional(),
    reason: HandoffReasonSchema,
  })
  .refine((v) => v.userId !== undefined || v.teamId !== undefined, {
    message: 'Provide at least one of userId or teamId',
  });

export const TicketEscalateInputSchema = z.object({
  /** Absent: recipients are derived (0011 decision 6). */
  toUserId: IdSchema.optional(),
  reason: HandoffReasonSchema,
});

export const TicketEscalationResponseSchema = z.object({
  /** The `ticket_events` row this escalation wrote. */
  id: IdSchema,
  ticketId: IdSchema,
  reason: z.string(),
  escalatedByUserId: IdSchema,
  /** Never empty — an escalation with no recipient is refused, not recorded. */
  recipientUserIds: z.array(IdSchema).min(1),
  createdAt: TimestampSchema,
});

/** One recipient's copy, for the supervisor's own list. */
export const EscalationResponseSchema = z.object({
  id: IdSchema,
  ticketId: IdSchema,
  ticketNumber: z.number().int(),
  ticketSubject: z.string().nullable(),
  reason: z.string(),
  escalatedByUserId: IdSchema,
  createdAt: TimestampSchema,
  acknowledgedAt: TimestampSchema.nullable(),
});

export const EscalationListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Default true: the supervisor's landing view is what still needs attention. */
  unacknowledgedOnly: z.stringbool().default(true),
});

export const TicketEventListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Amendments to shapes already published:
//   TICKET_EVENT_TYPES     += 'escalated'
//   TicketEventSchema      += fromType, toType: TicketEventValueTypeSchema.nullable()
//   TicketListQuerySchema  += escalatedOnly: z.stringbool().default(false)
export const TICKET_EVENT_VALUE_TYPES = [
  'user',
  'team',
  'status',
  'priority',
  'conversation',
  'sla_target',
] as const;
```

`TicketResponse` gains `escalatedAt: TimestampSchema.nullable()`. It is additive to a shape the
console already reads, so TAR-470 shows the badge without a second fetch.

### HTTP surface

Additive to 0002's endpoint table.

```
POST   /api/v1/tickets/{id}/handoff      → TicketResponse             ticket:handoff    200
POST   /api/v1/tickets/{id}/escalate     → TicketEscalationResponse   ticket:escalate   201
GET    /api/v1/tickets/{id}/events       → CursorPage<TicketEvent>    ticket:read       200
GET    /api/v1/escalations               → CursorPage<EscalationResponse>  ticket:read  200
POST   /api/v1/escalations/{id}/acknowledge → EscalationResponse      ticket:read       200
```

- **`/handoff` answers 200, not 201.** Nothing is created; the body is the ticket as it now stands,
  the same shape `/assign` returns, so the console puts the response straight into its cache.
- **`/escalate` answers 201.** An escalation _is_ a created record with an id a client can
  acknowledge, which is the difference from `/handoff`.
- **`GET /escalations` needs no `_all` permission**, and this is 0006's argument for `GET /sla-alerts`
  unchanged: every row names its recipient, and the query adds
  `recipient_user_id = principal.userId` on top of RLS. An agent may call it and sees an empty page,
  which is correct and needs no special case.
- **No `Idempotency-Key` on either write.** 0002 requires the header on sends and billing only. See
  the escalation risk below for what that costs.
- **Path ids are validated as UUIDs before anything is looked up**, via the `ticketIdPipe()` the
  controller already declares — a non-UUID is a 400, never a driver error surfacing as a 500.
- **`GET /tickets/{id}/events` paginates on `(created_at DESC, id DESC)`**, which is the index
  `ticket_events` already carries. Same `CursorPage` envelope and same opaque-cursor rules as the
  ticket queue; a malformed cursor is `validation_failed` naming the parameter.

### Behaviour worth stating

- **A handoff that moves nothing writes nothing.** Naming the agent who already holds the ticket
  returns 200 with the current ticket and appends no event — the double-clicked-button rule
  `TicketCommandService.assign` already applies, and it matters more here: every no-op that wrote an
  event would put a second reason in the history an escalation is read from.
- **A handoff never releases a ticket.** `userId: null` and `teamId: null` are not in the schema at
  all; releasing is `/assign`, and it is a supervisor's act.
- **A handoff sets `routing_state = 'manual'`** through the shared writer, exactly as `/assign` does —
  a person's decision, which routing must not overrule (0008 decision 3).
- **Neither route announces `ticket.updated`.** That event carries status and priority, and neither
  moves. 0008's Realtime section already rules that pushing a routing change is out of scope; the
  console refetches.
- **Neither route enqueues an SLA evaluation.** 0006's fourth trigger is a **status** change. A
  deadline does not move because a ticket changed hands or because somebody asked for help.
- **The target of a handoff is validated exactly as `/assign` validates its assignee** — active users
  and existing teams of this tenant, read through `TenantPrisma`, refused as `validation_failed`
  naming the field. There is no capacity check: the concurrent-ticket cap governs rotation, not a
  person's judgement.
- **Escalating a `resolved` or `closed` ticket is refused with `conflict`.** Nobody is working it, and
  a supervisor woken for a closed ticket learns to ignore the notification.

### Errors

Every failure maps onto the taxonomy 0002 publishes. **No new error codes** — the rule
`tickets.http.ts` states.

| Condition                                                | Code                | Status | Body detail            |
| -------------------------------------------------------- | ------------------- | ------ | ---------------------- |
| Ticket invisible to the caller, or another tenant's      | `not_found`         | 404    | —                      |
| `reason` missing, empty after trim, or over 500          | `validation_failed` | 400    | `path: "reason"`       |
| Neither `userId` nor `teamId` on a handoff               | `validation_failed` | 400    | `path: "userId"`       |
| `userId` / `teamId` names a stranger or an inactive user | `validation_failed` | 400    | `path` names the field |
| `toUserId` is not an active supervisor or admin          | `validation_failed` | 400    | `path: "toUserId"`     |
| Caller does not hold the ticket (handoff)                | `forbidden`         | 403    | —                      |
| Caller lacks the permission                              | `forbidden`         | 403    | —                      |
| Escalating a `resolved` / `closed` ticket                | `conflict`          | 409    | —                      |
| Tenant has no active supervisor or admin                 | `conflict`          | 409    | —                      |
| Acknowledging an escalation that is not yours            | `not_found`         | 404    | —                      |

Acknowledging twice is **not** a conflict: first write wins, 200, the same rule `sla_alerts` states.

### Realtime

```ts
{ event: 'ticket.escalated', escalation: EscalationResponse }
```

Emitted to `userRoom(recipient.userId)`, **once per row the insert returned** — not per resolved
recipient. The distinction is 0006 decision 5's and it is load-bearing: the rows are the record, and
an emit that outran them would tell somebody about an escalation nothing persisted. After the
transaction commits, never inside it.

## Failure modes and operations

| Component            | Slow                                                                              | Down                                                                                        | Bad data                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handoff write        | A supervisor's `/assign` may interleave; last writer wins and both are in the log | 5xx, nothing written — the event and the columns commit together or not at all              | A target that went inactive between check and write lands assigned; the next routing pass or a supervisor corrects it, as `/assign` already accepts |
| Escalation write     | —                                                                                 | 5xx, nothing written; the agent retries and a _new_ event id is minted (see the risk below) | —                                                                                                                                                   |
| Recipient resolution | —                                                                                 | Empty candidate set → `conflict`, and the agent is told rather than silently unheard        | A supervisor who left a team since is still a valid recipient; a broad alert beats none (0006 decision 4)                                           |
| Realtime relay       | Notification arrives late; the row is already there                               | Nobody is pushed; the supervisor sees it on their next page load                            | —                                                                                                                                                   |
| Event read           | Keyset page on an existing index; no table scan                                   | Read fails, 5xx; no write is at risk                                                        | An unknown `type` is served with null values, never dropped                                                                                         |

**What is monitored:** the count of escalations refused for having no recipient — a tenant hitting it
repeatedly has a role-configuration problem no error message will fix, and it is invisible otherwise.
**What pages someone:** nothing new. An escalation is a tenant-level workflow event; a platform
operator is not the right responder.

## Security and access

- **Tenant scoping is RLS and nothing else.** Every statement on both routes runs through
  `TenantPrisma` with `app.tenant_id` set, and no service on this surface takes a `tenantId`
  parameter. `ticket_escalations` carries `tenant_id NOT NULL` and its own policy; its composite
  foreign keys are `(tenant_id, …)` so a row cannot reference another tenant's ticket, event or user
  even if application code tried.
- **Cross-tenant attempts, by route:** reading, handing off or escalating another tenant's ticket is
  `404 not_found` and the row is unchanged; `toUserId`, `userId` or `teamId` naming another tenant's
  principal is `validation_failed`, because RLS makes the id resolve to nothing; listing escalations
  from another tenant's host returns only that tenant's own. Acknowledging another tenant's — or
  another supervisor's — escalation is `404`.
- **Intra-tenant is the layer RLS cannot supply**, and it is two rules: the ticket visibility check
  in front of every route (`ticket:read`, widened by `ticket:read_all`), and
  `recipient_user_id = principal.userId` on the escalation list and acknowledge.
- **Neither new permission widens visibility.** An agent who can escalate a ticket is an agent who
  could already read it.
- **`reason` is agent free text and is exported nowhere.** It lives on `ticket_events` and
  `ticket_escalations`, both per-ticket surfaces, and never reaches `audit_logs` — which is the table
  0004 forbids putting tenant prose into. It is not rendered as HTML by the console without escaping.
- **No secret, token or message body appears in any shape on this surface.**

## Implementation phases

| Stage | Issue       | Delivers                                                                                                                                                                                                                                                                  | Unblocks |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 2     | **TAR-468** | `ticket_escalations` + RLS policy; `TicketEvent @@unique([tenantId, id])`; `tickets.escalated_at` + its partial index; migration and the integration test that fails if the predicated index or the policy goes missing                                                   | 469      |
| 3     | **TAR-469** | The contracts above; `ticket:handoff` / `ticket:escalate` in `rbac.ts`; both write routes through one shared writer; the event read and its mapping; `GET /escalations` and acknowledge; the realtime emit                                                                | 471      |
| 3     | **TAR-470** | Reassign and escalate dialogs with a required reason, the ticket's activity timeline off `GET /tickets/{id}/events`, the escalation badge and the supervisor's escalation list. **Can start as soon as TAR-467 lands** — every shape it mocks against is in this document | 471      |
| 4     | **TAR-471** | The tenant-isolation matrix above, each error row, the no-op handoff, the unknown-event-type case, the empty-recipient refusal                                                                                                                                            | 472      |
| 5     | **TAR-472** | Review                                                                                                                                                                                                                                                                    | 473      |
| 6     | **TAR-473** | `docs/reference/tickets-api.md` — replace "not implemented yet (TAR-32)" with the real surface; a tenant-user guide for reassigning and escalating                                                                                                                        | —        |

TAR-470 does not wait for TAR-469. The contract is fixed here and `apps/web/lib/api/mock` is the
seam it mocks against, which is what takes the frontend off the critical path.

## Open questions and risks

| #   | Risk / question                                                                                                                                                                                    | Severity | Proposed resolution                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Escalation has no idempotency key.** A double-click or a retry after a dropped response mints a second event id, so the unique index does not catch it, and two escalations reach the supervisor | Medium   | TAR-470 disables the button on submit; TAR-471 asserts the duplicate is visible rather than silent. If real use shows noise, the fix is a `409` when an unacknowledged escalation by the same actor exists on the ticket — one query, additive, no contract change |
| 2   | **Does escalating imply the supervisor should take the ticket?** Decision 4 says no. It is the one decision here a product owner could reasonably reverse                                          | Medium   | Confirm with the PO before TAR-470 builds the dialog. Reversing it is an additive `assignToRecipient: boolean` on the escalate body, not a redesign                                                                                                                |
| 3   | **`ticket_escalations` duplicates `sla_alerts`' shape**, and a third notification type would make three                                                                                            | Low      | Accepted deliberately (decision 5). Revisit the `ticket_alerts` generalisation when the third arrives, with two real query patterns in hand                                                                                                                        |
| 4   | **`escalated_at` is never cleared**, so `escalatedOnly` accumulates over a tenant's lifetime                                                                                                       | Low      | Bounded in practice by the queue's active-status default. If a supervisor asks for "currently escalated", the answer is the unacknowledged-rows query, not a cleared column                                                                                        |
| 5   | **A supervisor who acknowledges does not stop the other recipients being notified**                                                                                                                | Low      | Correct as designed — each recipient acknowledges their own copy, as `sla_alerts` already works. Revisit only if tenants report duplicated effort                                                                                                                  |
| 6   | **`reason` at 500 characters is a guess**, matched to the existing assign cap                                                                                                                      | Low      | Confirm against real use. Widening a `varchar` is a cheap migration; narrowing is not                                                                                                                                                                              |
