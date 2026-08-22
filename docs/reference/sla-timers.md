# SLA timers and supervisor alerts

How a ticket acquires a response deadline, what happens when it passes, and the two
resources that surface it: `GET`/`PATCH /api/v1/sla-policies` and `GET /api/v1/sla-alerts`.
Written for engineers building against the API or operating the platform.

A **timer** is a deadline on one ticket for one target. A **policy** is the tenant's
configuration that decides the window. A **breach** is a timer whose deadline passed with
the target unmet; the console calls it _overdue_. An **alert** is one durable row telling
one supervisor about one breach.

The supervisor's version of this page — what the badge means, and how the alert bell
behaves — is [Watch tickets that miss their deadline](../guides/track-overdue-tickets.md).

Request and response shapes are defined in `packages/contracts/src/sla.ts` and validated at
the boundary. Enforcement lives in `apps/api/src/sla/`. The behaviour below is ruled by
[0006 — SLA timers and supervisor alerts](../architecture/0006-sla-timers-and-supervisor-alerts.md),
including its two post-merge amendments. Every request and response on this page was
executed against a local stack; see [Verification](#verification).

## Conventions

| Concern           | Rule                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| Base path         | `/api/v1`                                                                       |
| Tenant            | Resolved from the request `Host`, never from a body, header or query parameter  |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                 |
| Lists             | `{ items, nextCursor }`. Keyset paginated, `limit` 1–100, default 25            |
| Timestamps        | ISO 8601 with an explicit offset                                                |
| Error shape       | The standard envelope, with a code from `packages/contracts/src/error-codes.ts` |
| `Idempotency-Key` | Not used here. Both writes are idempotent by construction — see each            |

## Authentication and permissions

Every route requires a signed-in user presenting the session cookie `wac_session`
(`__Host-wac_session` wherever `SESSION_COOKIE_SECURE` is on).

| Route                                      | Permission    | Held by           |
| ------------------------------------------ | ------------- | ----------------- |
| `GET /api/v1/sla-policies`                 | `sla:read`    | supervisor, admin |
| `GET /api/v1/sla-policies/{id}`            | `sla:read`    | supervisor, admin |
| `PATCH /api/v1/sla-policies/{id}`          | `sla:write`   | supervisor, admin |
| `GET /api/v1/sla-alerts`                   | `ticket:read` | every role        |
| `POST /api/v1/sla-alerts/{id}/acknowledge` | `ticket:read` | every role        |

This surface **adds no permission and moves no grant**. `sla:read` and `sla:write` already
existed in [the RBAC matrix](../architecture/0004-rbac-permission-matrix.md); `ticket:read`
is held by everyone.

**The alert routes deliberately have no `_all` permission.** Every `notifications` row names
its recipient, and the service adds `recipient_user_id = principal.userId` on top of
row-level security (RLS). Two layers, and the outer one is what stops one supervisor reading
another's queue. An agent may call `GET /api/v1/sla-alerts` and gets an empty page — that is
the whole of the role-scoping requirement, enforced server-side rather than by hiding a
button. A dedicated permission would say the same thing twice and give a supervisor a way to
be granted somebody else's queue.

**Another principal's alert answers `404`, not `403`.** A 403 would confirm the id names a
real alert somebody else was sent, on a resource whose entire point is that it was addressed
to one person.

## Configuring the window

### Where the number lives

The platform default is `SLA_DEFAULTS` in `packages/contracts/src/sla.ts` —
`firstResponseMinutes: 60`, `resolutionMinutes: null`. It is a **seed value, not a runtime
fallback**: provisioning writes one `sla_policies` row per tenant from it, and nothing ever
reasserts it over a tenant's own edit.

Only the first-response timer exists at v1. The seeded policy leaves `resolutionMinutes`
null, so no resolution timer is created until a tenant sets one.

Three writers converge on that row and all three are guarded on **"the tenant has no policy
at all"**, never on "no active policy", so they cannot race and none of them can resurrect
SLA for a tenant that turned it off:

| Writer                             | When                                             |
| ---------------------------------- | ------------------------------------------------ |
| `TenantProvisioningService`        | A tenant is provisioned                          |
| The backfill in `20260813130000_…` | Once, for tenants that existed before this story |
| `SlaPolicyService.createDefault`   | Lazily, on the first evaluation that finds none  |

### Which policy applies to a ticket

Among the tenant's policies, `resolvePolicyForPriority` takes:

1. the **active** ones (`isActive: true`), then
2. one whose `priority` equals the ticket's, then
3. the catch-all, `priority IS NULL`, with
4. oldest `createdAt` breaking a tie, and the id breaking that.

No active policy means **no timers**, and the ticket reports `not_applicable`. That is a
tenant decision being honoured rather than a gap.

The tie-break is creation order rather than "most specific wins twice over": two active
policies for the same priority is a state the API permits, and picking deterministically is
worth more than picking cleverly. The alternative is a ticket whose deadline depends on which
row the planner returned first.

### What an edit does, and what it does not

**Editing a window changes future tickets, never past deadlines.** A running timer carries
its own `due_at`, written when it started; nothing derives a deadline from the policy at read
time. Shortening the window does not retroactively breach yesterday's tickets, and
lengthening it does not un-breach them.

A ticket that already has timers also keeps **the policy it started under**, so changing a
ticket's priority cannot move a deadline that is already running.

**Turning SLA off is `PATCH { "isActive": false }`.** There is no `DELETE`, which mirrors how
a tenant is deactivated rather than deleted and leaves the row that running timers point at
intact.

### The console surface

TAR-390 added **Settings → Response deadlines** (`/settings/sla`), so the window no longer
needs an API call made on somebody's behalf. It reads `GET /sla-policies` and writes
`PATCH /sla-policies/{id}`; there is nothing it can do that this page does not describe.

| Console control             | Field on the request                     |
| --------------------------- | ---------------------------------------- |
| Give new tickets a deadline | `isActive`                               |
| First response, in minutes  | `firstResponseMinutes` — empty is `null` |
| Resolution, in minutes      | `resolutionMinutes` — empty is `null`    |

It edits **the catch-all only**. Per-priority policies are listed read-only under _Priority
overrides_, because `SlaPolicyUpdateInputSchema` accepts no `priority` and the resource has no
`POST` — a control for either would be one the API refuses. `businessHoursOnly` has no
control for the same reason.

The form submits all three fields on every save rather than a diff. `PATCH` is partial either
way, and replaying the same three values is idempotent by construction; a diff computed in the
browser against values that may already be stale is the version that silently drops an edit.

Gating is `sla:read` to reach the page and `sla:write` to change anything — the two the table
above already assigns. A principal holding only the read gets the same figures as a
description list rather than a 403 or a form of disabled inputs. The steps a supervisor
follows are in
[Watch tickets that miss their deadline](../guides/track-overdue-tickets.md#change-the-response-window).

## `GET /api/v1/sla-policies`

The tenant's policies, **oldest first** — so the seeded `Default` row, which is the one a
supervisor is looking for, leads the page. Keyset paginated on `(createdAt ASC, id ASC)`.

| Parameter | In    | Type   | Required | Default | Notes                                                                  |
| --------- | ----- | ------ | -------- | ------- | ---------------------------------------------------------------------- |
| `cursor`  | query | string | no       | —       | The `nextCursor` from the previous page. Opaque; pass it back verbatim |
| `limit`   | query | int    | no       | `25`    | 1–100                                                                  |

```bash
curl -b cookies.txt 'http://northwind.app.localhost:3051/api/v1/sla-policies'
```

```json
{
  "items": [
    {
      "id": "01a005a7-8b53-734f-9192-7509b2e308fc",
      "name": "Default",
      "priority": null,
      "firstResponseMinutes": 60,
      "resolutionMinutes": null,
      "businessHoursOnly": false,
      "isActive": true,
      "createdAt": "2026-08-15T13:41:01.388Z",
      "updatedAt": "2026-08-15T13:41:01.388Z"
    }
  ],
  "nextCursor": null
}
```

| Status | Code                | Cause                                         |
| ------ | ------------------- | --------------------------------------------- |
| `200`  | —                   |                                               |
| `400`  | `validation_failed` | A malformed `cursor`, or `limit` out of range |
| `403`  | `forbidden`         | The caller lacks `sla:read`                   |

`priority: null` means "any priority" — the catch-all every ticket falls back to.
`businessHoursOnly` is modelled but **not implemented**: it is always `false`, and the field
is published so the shape does not change when it is built. See
[Limits and known gaps](#limits-and-known-gaps).

## `GET /api/v1/sla-policies/{id}`

One policy.

| Parameter | In   | Type | Required | Default | Notes                                  |
| --------- | ---- | ---- | -------- | ------- | -------------------------------------- |
| `id`      | path | uuid | yes      | —       | A non-UUID answers 400, not 404 or 500 |

| Status | Code                | Cause                                                  |
| ------ | ------------------- | ------------------------------------------------------ |
| `200`  | —                   |                                                        |
| `400`  | `validation_failed` | `id` is not a UUID                                     |
| `403`  | `forbidden`         | The caller lacks `sla:read`                            |
| `404`  | `not_found`         | No such policy, **or** one belonging to another tenant |

```json
{
  "error": {
    "code": "not_found",
    "message": "No SLA policy matches that id.",
    "requestId": "bcd6f354-f255-4705-8eae-0334ac4e91dd"
  }
}
```

A policy id from another tenant is indistinguishable from one that names nothing. RLS makes
that true at the database; the service reports it identically so the API cannot be used to
probe for ids.

## `PATCH /api/v1/sla-policies/{id}`

A partial edit. The only write on this resource.

**Idempotency.** No `Idempotency-Key`. A `PATCH` of named fields to fixed values is
idempotent by construction — replaying it lands the row in the same state.

| Parameter              | In   | Type    | Required | Default | Notes                                    |
| ---------------------- | ---- | ------- | -------- | ------- | ---------------------------------------- |
| `id`                   | path | uuid    | yes      | —       |                                          |
| `name`                 | body | string  | no       | —       | 1–100 characters                         |
| `firstResponseMinutes` | body | int?    | no       | —       | 1–43 200, or `null` to remove the target |
| `resolutionMinutes`    | body | int?    | no       | —       | 1–43 200, or `null` to remove the target |
| `isActive`             | body | boolean | no       | —       | `false` turns SLA off for the tenant     |

At least one field is required. `priority` and `businessHoursOnly` are deliberately not
accepted: the first belongs with the per-priority policy UI that is out of scope, and the
second is modelled but not implemented, so accepting it would publish a switch that does
nothing.

```bash
curl -b cookies.txt -X PATCH \
  'http://northwind.app.localhost:3051/api/v1/sla-policies/01a005a7-8b53-734f-9192-7509b2e308fc' \
  -H 'Content-Type: application/json' \
  -d '{"firstResponseMinutes":30}'
```

```json
{
  "id": "01a005a7-8b53-734f-9192-7509b2e308fc",
  "name": "Default",
  "priority": null,
  "firstResponseMinutes": 30,
  "resolutionMinutes": null,
  "businessHoursOnly": false,
  "isActive": true,
  "createdAt": "2026-08-15T13:41:01.388Z",
  "updatedAt": "2026-08-15T13:42:40.782Z"
}
```

| Status | Code                | Cause                                                           |
| ------ | ------------------- | --------------------------------------------------------------- |
| `200`  | —                   |                                                                 |
| `400`  | `validation_failed` | An empty body, a window outside 1–43 200, or `id` is not a UUID |
| `403`  | `forbidden`         | The caller lacks `sla:write`                                    |
| `404`  | `not_found`         | No such policy, or one belonging to another tenant              |

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request body failed validation.",
    "details": [
      { "path": "firstResponseMinutes", "message": "Too big: expected number to be <=43200" }
    ],
    "requestId": "9aa85c5b-feed-42c1-a50d-e998ab6d4913"
  }
}
```

An empty body reports the same code against the object itself:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request body failed validation.",
    "details": [{ "path": "", "message": "Provide at least one field" }],
    "requestId": "7e95e50c-2da4-4c09-99d3-8f78e168a339"
  }
}
```

43 200 is thirty days in minutes — an upper bound that rejects a typo (a window entered in
seconds, a stray zero) without pretending to know a tenant's business.

**There is no `POST` and no `DELETE` at v1.** The seeded row satisfies the story, and a
create surface is only meaningful alongside the per-priority policy UI that is out of scope.

## `GET /api/v1/sla-alerts`

The **calling principal's** alerts, newest first. Keyset paginated on
`(createdAt DESC, id DESC)`.

| Parameter            | In    | Type   | Required | Default | Notes                                               |
| -------------------- | ----- | ------ | -------- | ------- | --------------------------------------------------- |
| `cursor`             | query | string | no       | —       | The `nextCursor` from the previous page             |
| `limit`              | query | int    | no       | `25`    | 1–100                                               |
| `unacknowledgedOnly` | query | bool   | no       | `true`  | Send `false` to include alerts already acknowledged |

The default is `true` because the supervisor's landing view is what still needs attention.
The parameter is parsed from the **string** the client actually sends: a plain boolean schema
would answer 400 to `?unacknowledgedOnly=false`, making "show me everything" unreachable.

```bash
curl -b cookies.txt 'http://northwind.app.localhost:3051/api/v1/sla-alerts'
```

```json
{
  "items": [
    {
      "id": "01a005aa-a9b9-75af-95f2-4f90d45b4543",
      "ticketId": "0192f008-0000-7000-8000-000000000801",
      "ticketNumber": 1,
      "slaTimerId": "0192f00e-0000-7000-8000-000000000e01",
      "kind": "first_response",
      "dueAt": "2026-08-15T13:39:12.610Z",
      "assignedUserId": "0192f001-0000-7000-8000-000000000101",
      "assignedTeamId": "0192f002-0000-7000-8000-000000000201",
      "acknowledgedAt": null,
      "createdAt": "2026-08-15T13:44:25.785Z"
    }
  ],
  "nextCursor": null
}
```

| Status | Code                | Cause                                         |
| ------ | ------------------- | --------------------------------------------- |
| `200`  | —                   | Including an empty page for a non-recipient   |
| `400`  | `validation_failed` | A malformed `cursor`, or `limit` out of range |

Four fields behave in ways the shape does not show:

- **`dueAt` is the deadline that was missed, copied at write time.** A later policy edit must
  not rewrite history, so this is the alert's own copy rather than a read through to the timer.
- **`createdAt` is when the breach was **detected**, not when it was due.** The gap between
  the two is the sweep's detection latency.
- **`assignedUserId` and `assignedTeamId` say who was holding the ticket**, and both are null
  when nobody was. A recipient can legitimately receive an alert about a holder they cannot
  name — see the fallback in [Who is told](#who-is-told).
- **`kind` is denormalised from the timer** so the list needs no join.

Alerts carry no message content: a ticket number, a deadline and ids. Nothing in the row or
the push is data the same principal could not already read on the ticket queue.

## `POST /api/v1/sla-alerts/{id}/acknowledge`

Marks one alert seen. Answers `200` with the alert.

**Idempotency.** A second call returns the same row with the **original**
`acknowledgedAt`; nothing is a `409`. First write wins, in the `WHERE` clause rather than by
reading first — the timestamp answers "when did you see this", and two tabs clicking at once
must not move it.

A sub-resource `POST` rather than a `PATCH` of the timestamp, per the contract's convention
for a non-CRUD verb, and because the timestamp is the server's to decide rather than a value
a client may name.

| Parameter | In   | Type | Required | Default | Notes |
| --------- | ---- | ---- | -------- | ------- | ----- |
| `id`      | path | uuid | yes      | —       |       |

```bash
curl -b cookies.txt -X POST \
  'http://northwind.app.localhost:3051/api/v1/sla-alerts/0192f00f-0000-7000-8000-000000000f01/acknowledge'
```

```json
{
  "id": "0192f00f-0000-7000-8000-000000000f01",
  "ticketId": "0192f008-0000-7000-8000-000000000803",
  "ticketNumber": 3,
  "slaTimerId": "0192f00e-0000-7000-8000-000000000e03",
  "kind": "first_response",
  "dueAt": "2026-08-14T08:41:01.161Z",
  "assignedUserId": "0192f001-0000-7000-8000-000000000104",
  "assignedTeamId": "0192f002-0000-7000-8000-000000000202",
  "acknowledgedAt": "2026-08-15T13:42:51.350Z",
  "createdAt": "2026-08-14T08:41:21.161Z"
}
```

| Status | Code                | Cause                                                                           |
| ------ | ------------------- | ------------------------------------------------------------------------------- |
| `200`  | —                   | Including a replay, which returns the first `acknowledgedAt`                    |
| `400`  | `validation_failed` | `id` is not a UUID                                                              |
| `404`  | `not_found`         | No such alert, one in another tenant, **or one addressed to another principal** |

Acknowledging changes nothing about the ticket or the timer. It is a read receipt on the
notification, not an action on the work.

## The timer lifecycle

```text
                    ticket created, policy resolved
                                 │
                                 ▼
   status → pending      ┌──────────────┐      first agent reply (first_response)
        ┌───────────────▶│   running    │──────────────────────────▶ met
        │                └──────────────┘      ticket resolved (resolution)
        │                   │        │
        ▼                   │        └────── due_at <= now(), swept ──▶ breached
   ┌──────────┐             │
   │  paused  │─────────────┘  customer replies, or status → open
   └──────────┘
        │
        └────────────── ticket closed unresolved ──▶ cancelled
```

`met`, `breached` and `cancelled` are terminal.

**`breached` is terminal on purpose.** A ticket answered after it breached still stamps
`tickets.first_response_at` and stops accruing, but the timer stays `breached`: the
supervisor's record of the miss is not erased by a late reply.

### What starts and moves a timer

Four ticket-level triggers, all of which enqueue **the same durable job**,
`sla.evaluate-ticket`, carrying `{ tenantId, ticketId, reason }`:

| When                                      | Effect                                                    |
| ----------------------------------------- | --------------------------------------------------------- |
| A ticket is created                       | Start the timers the resolved policy defines              |
| An outbound message from a person commits | Stop `first_response` as `met`; stamp `first_response_at` |
| A ticket's status changes                 | Pause, resume, stop or cancel                             |
| A customer replies to a `pending` ticket  | Resume                                                    |

`reason` is **for logs only**. The handler is a reconciler: it re-derives the whole timer
state for the ticket from the row and never branches on the trigger. That is what makes
at-least-once delivery safe — a job that is lost, duplicated or delivered out of order
converges on the same state.

### Three rules worth knowing before you build against this

**The deadline is anchored to the ticket, not to the job.** A timer is created with
`startedAt = ticket.createdAt` and `dueAt = ticket.createdAt + window`. A job that runs late
hands the ticket no free extension — which it would if the deadline were measured from
`now()`, and which would be invisible: a Redis outage would look like everybody suddenly
meeting their SLA.

**Only a person's reply stops the first-response clock.** What decides is an outbound message
with a non-null `sender_user_id` sent at or after the ticket was opened. A chatbot reply
writes no `sender_user_id` and therefore does not stop the clock. That is a decision recorded
rather than an accident of whichever path writes the message.

**Pausing moves the deadline forward, it does not freeze a countdown.** Resume is
`due_at = due_at + (now() - paused_at)` in one guarded SQL statement, so no read-modify-write
window exists for two workers to interleave. `paused_ms` accumulates alongside it for
reporting and is never read by the sweep. Every timestamp is Postgres `now()`, never a node
clock: skew between API instances must not be able to breach a timer early or hold one open.

## How a breach is detected

**A breach is a time becoming true, not a request arriving.** Nothing calls the API when a
deadline passes, so something has to notice — exactly once per transition, across replicas,
restarts and a Redis outage, while every read and write stays inside one tenant.

That something is a **repeatable BullMQ job every `SLA_SWEEP_INTERVAL_MS`** (default 30 000),
installed under the scheduler key `sla-sweep`. It is not a delayed job scheduled per timer,
for two reasons that are worth understanding before proposing one:

- **The deadline lives in Postgres and Redis is treated as losable.** A delayed job stores the
  deadline in Redis, so a flush loses breaches with no error, no retry and no failed set — an
  alert that simply never comes.
- **`due_at` moves**, on every pause and resume. A stale scheduled job that escaped
  cancellation fires early, which is a **false** breach — worse than a late one.

The cost, stated plainly: **detection latency is bounded by the interval plus queue wait.**
Thirty seconds against a 60-minute window is 0.8% of it. The predicate is `due_at <= now()`
rather than "due since the last tick", so catch-up after an outage of any length is free — the
first sweep drains the backlog with no re-arming step.

### The sweep runs in two phases

**Phase 1** finds due timers across every tenant. It is the one place in this feature that
runs on `SystemPrisma`, and the shape is the justification: read-only, two uuid columns, and
it reaches no caller. It takes at most `SLA_SWEEP_TENANT_BATCH` (50) rows from any one tenant
and `SLA_SWEEP_BATCH` (200) overall, joined to `tenants.status = 'active'`.

**Phase 2** groups those pairs by tenant and does every read and write inside
`$tenantTransaction`, under RLS, in chunks of `SLA_SWEEP_TENANT_CHUNK` (25). The writes are
the dangerous half: an alert row inserted with the wrong `tenant_id` under the system role
would be a cross-tenant leak RLS would otherwise have refused.

Both bounds exist because of the same hazard, and neither is redundant. **A timer that is not
claimed only gets older**, so it sorts to the head of the next batch and of every batch after
it. Without the per-tenant cap, one tenant recovering from an outage owns the whole batch and
no other tenant's breaches are examined at all. Without chunking, a transaction that overruns
its timeout rolls back everything, and the identical rows lead the next sweep into the
identical timeout — a livelock reported as nothing louder than one warning per tick.

### The claim does not trust a job to have run

Before claiming anything, phase 2 **re-derives the state of every due ticket** in the same
transaction, through the same reconciler the trigger job would have run.

This is not defensive coding. `state = 'running'` is only a guard if something reliably moves
a timer out of `running` the moment its target is met — and the only thing that did was a
queue job the producer is contractually allowed to drop. A two-second Redis blip was enough:
an agent replied at minute 40 of a 60-minute window, the enqueue failed, and the next sweep
flipped the timer to a **permanent** false breach and alerted a supervisor about a ticket
answered twenty minutes early.

A ticket that was answered, resolved, closed or paused therefore reaches `met`, `cancelled`
or `paused` in the re-derivation, and the claim no longer matches it. One that is genuinely
overdue is left `running` and breaches.

Two details that look like implementation trivia and are not:

- **It settles those timers rather than skipping them.** A timer the claim merely declined
  would stay `running` and past due, occupying its tenant's whole batch allowance for ever
  while that tenant's real breaches went unexamined.
- **It re-derives rather than adding a reply check to the claim's SQL.** "Has a person
  replied" has one answer in this codebase; two implementations of it would drift. The
  obvious patch — `AND NOT EXISTS (… first_response_at IS NOT NULL)` — does not even work,
  because that column's only writer is the same job that was dropped.

### Exactly one alert per breach

Three independent layers, each covering a different failure. Only the first is load-bearing:

| Layer                                                                       | Covers                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `UPDATE … WHERE state = 'running'`, and only rows it moved are alerted      | Two replicas sweeping the same timer. One gets the row, the other gets none |
| `UNIQUE (tenant_id, sla_timer_id, recipient_user_id)`                       | A retry after a partial failure re-inserts nothing                          |
| The `sla_breached` ticket event written in the same transaction as the flip | An append-only log with no unique constraint to fall back on                |

Nothing here reads, decides in TypeScript, then writes. The window between such a read and
its write is exactly the window two replicas race in, and the bug it produces is a duplicate
alert every thirty seconds.

⚠️ **These jobs carry no custom BullMQ id, and nothing may reintroduce one keyed on the
ticket.** A ticket-keyed id collapsed every trigger after the first into the completed key of
the one before it, silently dropping the reply that should have stopped the timer. If you add
an id, key it on the **event**, never on the ticket.

## Who is told

There is no manager link in the people model — nothing says which supervisor a given agent
reports to. Recipients are therefore derived:

1. The **responsible party** is `tickets.assigned_user_id`, or `assigned_team_id` when no user
   holds it, or nobody.
2. **Candidates** are the tenant's users with role `supervisor` or `admin` and status
   `active` — the same population as "holds `ticket:read_all`", so an alert exposes nothing
   its recipient could not already read.
3. **Narrow** to candidates sharing a team with the responsible party.
4. **Fall back** to every candidate in the tenant when step 3 yields nobody — the agent is in
   no team, no supervisor shares one, or the ticket is unassigned.
5. If the tenant has no active supervisor or admin at all, **no alert rows are written** and a
   warning names the ticket. The ticket still shows overdue in the queue.

A broad alert is worse than a narrow one; an alert delivered to nobody is worse than both.

The assigned agent is **not** excluded when they are themselves a supervisor. A supervisor
working a queue wants to know their own ticket breached.

## Delivery

Each recipient gets **both**:

- A durable `notifications` row. This is the record. It survives a restart, a missed socket and a
  supervisor who was asleep, and it doubles as the idempotency ledger.
- An `sla.breached` realtime event addressed to `user:{recipientId}` — one emit per row that
  was actually inserted, after the transaction commits.

**A breach also raises a workflow trigger.** Once the flip and its alerts commit, the sweep
enqueues a `ticket_sla_breached` occurrence, so a tenant's own automation can tag, reassign or
re-prioritise the ticket — [the workflow automation API reference](workflows-api.md). The
enqueue is logged and swallowed on failure, and `breached` is terminal, so nothing re-derives
it: this is the one trigger with no reconciler.

If the process dies between commit and emit, the row exists and the supervisor sees it on
their next page load. **The row is the record; the socket is an accelerator.** The event is
deliberately not broadcast to a tenant-wide room: the read rule is "you are a named
recipient", and the socket audience must equal the rows written.

The ticket's own queue row also changes, so the sweep emits the existing `ticket.updated`
alongside, addressed to the ticket's normal audience, so the queue badge moves for everyone
entitled to see the ticket without a refetch.

```ts
// packages/contracts — one new member of ServerEventSchema
{
  event: 'sla.breached',
  alert: SlaAlertResponse,
  ticket: TicketResponse,
}
```

⚠️ **The console's alert badge is not live.** `sla.breached` is mapped to `ignore` in the web
client's event router, so a supervisor sitting on a page when a ticket breaches sees the count
change on the next full render rather than immediately. Nothing is lost — the row is the
record — but do not read the badge as a liveness mechanism.

## Reading SLA state off a ticket

The ticket queue needs no separate call. `TicketResponse.sla` carries the state and the
deadline for both targets, and `GET /api/v1/tickets?breachedOnly=true` filters to tickets with
a breached timer. Both are documented in
[the tickets API reference](tickets-api.md#get-apiv1tickets).

| Timer row for a kind | State reported   | Deadline reported |
| -------------------- | ---------------- | ----------------- |
| absent               | `not_applicable` | `null`            |
| `running`            | `running`        | `dueAt`           |
| `paused`             | `paused`         | `dueAt`           |
| `met`                | `met`            | `dueAt`           |
| `breached`           | `breached`       | `dueAt`           |
| `cancelled`          | `not_applicable` | `null`            |

**"How overdue" is computed client-side**, as `now - dueAt`. The API publishes the deadline
and never a duration, because a duration is stale the moment it is serialised.

`isSlaBreached` in `packages/contracts/src/sla.ts` is the shared predicate behind both the
row flag and the `breachedOnly` filter, so a queue cannot draw the badge by one rule and
filter by another.

## Operations

| Setting                      | Default | What it governs                                  |
| ---------------------------- | ------- | ------------------------------------------------ |
| `SLA_SWEEP_INTERVAL_MS`      | `30000` | How often the sweep runs. Minimum 1 000          |
| `SLA_SWEEP_BATCH`            | `200`   | Due timers claimed per sweep across all tenants  |
| `SLA_SWEEP_TENANT_BATCH`     | `50`    | The most any one tenant may occupy of that batch |
| `SLA_SWEEP_TENANT_CHUNK`     | `25`    | Timers claimed and alerted per transaction       |
| `SLA_SWEEP_CHUNK_TIMEOUT_MS` | `20000` | How long one chunk's transaction may take        |
| `SLA_WORKER_CONCURRENCY`     | `4`     | Jobs this queue's worker runs in parallel        |

Only the first is an environment variable; the rest are constants in
`apps/api/src/sla/sla.constants.ts`.

The sweep logs one line on every run that finds work:

```text
SLA sweep: 1 due, 1 breached, 1 alerts in 48ms
```

with `, N tenant(s) inactive` and `, N tenant(s) failed` appended when either is non-zero.

**What should page someone**

- The `sla.sweep` job failing on consecutive runs — detection has stopped, and nothing else
  will notice.
- A full batch (200) returned on consecutive sweeps — detection is falling behind.
- The same tenant in the `failed` count on consecutive sweeps — that tenant's backlog is not
  draining.
- A sweep whose elapsed time approaches `SLA_SWEEP_INTERVAL_MS`.
- Any timer still `running` whose `due_at` is more than ten sweep intervals in the past — the
  sweep is running but not draining, which no other signal above would show.

**Breaches with zero alerts** on the same line means a tenant has nobody to tell: no active
supervisor or admin. It is a configuration problem, not a fault.

## Limits and known gaps

**Business hours are modelled but not implemented.** `businessHoursOnly` exists on the policy
and stays `false`. A wall-clock timer started at 17:30 breaches overnight, and a supervisor is
alerted about a window nobody was working in. Turning it on means a per-tenant holiday
calendar and timezone arithmetic — the moment it is on, `dueAt` stops being a timestamp you
can compare and becomes a function. It is its own story, not a flag flip.

**Per-customer SLA contracts are out of scope.** The tenant-wide policy is v1.

**Resolution SLAs are modelled but unseeded.** The shipped policy leaves `resolutionMinutes`
null, so only the first-response timer exists until a tenant sets one.

**A reply on a second conversation does not stop the timer.** A tenant running two WhatsApp
Business Accounts (WABAs) can have the same contact on a second conversation; v1 detects the
first response on the ticket's own conversation only.

**Nothing re-enqueues a lost `ticket_created` trigger.** A ticket whose start trigger was
dropped gets no timer until something else evaluates it. A sweep for tickets-with-no-timer
would close this; the breach sweep's re-derivation covers the _stop_ triggers, not the start.

**A timer already sitting at a false `breached`** from before the re-derivation landed is left
alone. `breached` is terminal by design, and unwinding it is a data decision rather than a
code one.

**`notifications` has no retention policy** and the table grows without bound. It must be
settled before the first large tenant, and TAR-27's `workflow_runs` has since arrived with the
same gap — one sweeper with two predicates settles both.

## Verification

Every request and response on this page was executed against a local stack from `main` at
`ea97c4e`: `docker compose up -d --wait`, `pnpm db:migrate:deploy`, `pnpm db:roles`,
`pnpm db:roles:login`, `pnpm db:seed`, then the built API on port `3051`. Ids, timestamps and
request ids are the values that run returned.

⚠️ **The stack ran with `AUTH_STUB_ENABLED=true`** — the interim role stub driven by
`x-dev-role` — rather than with real session cookies, because seeded users carry no password
hash and this page needed a principal in each role. The stub resolves a real seeded user and
materialises its permissions from the real matrix, so what was exercised is the permission
model; what was **not** exercised is session issue and revocation. The `curl` samples above
are written with `-b cookies.txt`, which is how a real client authenticates.

Confirmed rather than assumed:

- The seeded default is one `Default` row, `firstResponseMinutes: 60`, `priority: null`.
- An agent calling `GET /api/v1/sla-alerts` gets `200` with an empty page, not a `403`.
- An agent calling `PATCH /api/v1/sla-policies/{id}` gets `403 forbidden`.
- Acknowledging twice returns the identical `acknowledgedAt` on both calls, and `200` both
  times.
- Acknowledging another principal's alert answers `404 not_found`.
- Reading a northwind policy id against the southwind host answers `404 not_found`.
- `unacknowledgedOnly` defaults to true: the acknowledged alert left the default list and
  reappeared under `?unacknowledgedOnly=false`.
- **The re-derivation works.** A timer forced back to `running` and past due on a ticket that
  a person had already answered was settled `met` by the next sweep, with
  `first_response_at` stamped and **zero** alerts written —
  `SLA sweep: 1 due, 0 breached, 0 alerts in 44ms`.
- **A genuine breach raises exactly one alert.** The same timer, with the ticket's replies made
  bot-authored, breached on the next sweep —
  `SLA sweep: 1 due, 1 breached, 1 alerts in 48ms` — writing one `notifications` row and one
  `sla_breached` ticket event, and no further alert on subsequent sweeps.
- **Recipients are narrowed by team.** That tenant has three active supervisor/admin
  candidates; only the one sharing a team with the assigned agent received the alert.
