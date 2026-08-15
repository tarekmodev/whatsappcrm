# Tickets API reference

The ticket queue and the two writes into a ticket: `GET /api/v1/tickets`,
`GET /api/v1/tickets/{id}`, `PATCH /api/v1/tickets/{id}` and
`POST /api/v1/tickets/{id}/assign`. Written for engineers building against the API or the
console.

A ticket is a **unit of work on** a conversation, not a copy of it. One conversation
accumulates many tickets over its life, and messages stay on the conversation so a thread
is never split. Tickets are opened automatically by TAR-21's linker when a customer writes
in; this page documents reading the queue, changing a ticket's status, priority and
subject, and placing one by hand.

**Who a ticket is assigned to automatically** is not on this page. Rules pick the target
first ([the assignment rules API reference](assignment-rules-api.md)), and rotation places
whatever no rule claimed ([the auto-assignment reference](auto-assignment.md)).

Request and response shapes are defined in `packages/contracts/src/tickets.ts` and
validated at the boundary. Enforcement lives in `apps/api/src/tickets/`. The behaviour
below is ruled by _0006 — ticket status, priority and auto-reopen_ (TAR-278's decision
record) and summarised in
[ADR 0002, amendment 9](../architecture/0002-architecture-and-api-contract.md#amendment-9--the-ticket-queue-and-the-status-write-tar-25).
Every example was executed against a local stack; see [Verification](#verification).

> **TODO(author):** _0006 — ticket status, priority and auto-reopen_ is not in this
> repository. It is published as an attachment on TAR-278, and its number collides with
> [0006 — SLA timers and supervisor alerts](../architecture/0006-sla-timers-and-supervisor-alerts.md),
> which is why the source comments citing "0006 §2", "§4" and "§7" resolve to nothing a
> reader can open. Renumbering and filing it is TAR-278's to do; this page and amendment 9
> cite it by title until it lands.

## Conventions

| Concern           | Rule                                                                              |
| ----------------- | --------------------------------------------------------------------------------- |
| Base path         | `/api/v1`                                                                         |
| Tenant            | Resolved from the request `Host`, never from a body, header or query parameter    |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                   |
| Lists             | `{ items, nextCursor }`. Keyset paginated, `limit` 1–100, default 25              |
| Timestamps        | ISO 8601 with an explicit offset                                                  |
| Error shape       | The standard envelope, with a code from `packages/contracts/src/error-codes.ts`   |
| `Idempotency-Key` | Not used here. A `PATCH` carries the target state, so a replay is the no-op below |

## Authentication

Every route requires a signed-in user, presenting the session cookie `wac_session` —
`__Host-wac_session` wherever `SESSION_COOKIE_SECURE` is on. Three global guards run before
any handler: **where** the request is (`HostTenantGuard`), **who** is making it
(`PrincipalGuard`), then **may they** (`PermissionGuard`).

| Condition                                        | Answer                |
| ------------------------------------------------ | --------------------- |
| No cookie, or an expired, revoked or unknown one | `401 unauthenticated` |
| A valid session belonging to a different tenant  | `401 tenant_mismatch` |
| Signed in, but the role lacks the permission     | `403 forbidden`       |
| The ticket is in another tenant                  | `404 not_found`       |

## Permissions

| Route                                                   | Permission                       | Held by           |
| ------------------------------------------------------- | -------------------------------- | ----------------- |
| `GET /api/v1/tickets`                                   | `ticket:read`                    | every role        |
| `GET /api/v1/tickets/{id}`                              | `ticket:read`                    | every role        |
| `PATCH /api/v1/tickets/{id}` — `subject`, `priority`    | `ticket:update`                  | every role        |
| `PATCH /api/v1/tickets/{id}` — `→ open`, `→ pending`    | `ticket:update`                  | every role        |
| `PATCH /api/v1/tickets/{id}` — `→ resolved`, `→ closed` | `ticket:update` + `ticket:close` | every role        |
| `POST /api/v1/tickets/{id}/assign`                      | `ticket:assign`                  | supervisor, admin |
| `ticket:read_all` — widens both reads                   | —                                | supervisor, admin |

There is no `ticket:write`. Three things about this table are not obvious from it:

- **`ticket:close` is checked in the service, not in the guard.** The guard is per-route and
  this is per-body: the same `PATCH` that closes a ticket also re-prioritises one, and only
  the request says which. Declaring both on the route would make re-prioritising a ticket
  require the right to close one.
- **Every shipped role holds both permissions today**, so no role's behaviour differs. The
  split buys a future triage-only role that may re-prioritise a queue without finishing
  somebody else's work. The matrix itself is
  [ADR 0004](../architecture/0004-rbac-permission-matrix.md).
- **`ticket:assign` is the one permission on this surface an agent does not hold.** Every
  role that holds it also holds `ticket:read_all`, which is what makes the visibility check
  in front of the write reachable for an _unassigned_ flagged ticket rather than answering
  404 on the one queue the endpoint exists to empty.

**Visibility is the narrow rule.** A ticket is visible to the principal it is assigned to,
to their teams, and — with `ticket:read_all` — to the whole tenant. Unlike the shared inbox,
an **unassigned ticket is not visible to every agent**: it is triaged work rather than a
customer waiting in a pool, so browsing the untriaged backlog needs `ticket:read_all`. A
ticket the caller may not see answers `not_found` on every route including the write, never
`forbidden`.

## `GET /api/v1/tickets`

The queue. With no `status` parameter it returns the tenant's **active** tickets —
`status IN ('open','pending')` — ordered `priority DESC, createdAt DESC, id DESC`.

| Parameter        | In    | Type   | Required | Default    | Notes                                                                   |
| ---------------- | ----- | ------ | -------- | ---------- | ----------------------------------------------------------------------- |
| `cursor`         | query | string | no       | —          | The `nextCursor` from the previous page. Opaque; pass it back verbatim  |
| `limit`          | query | int    | no       | `25`       | 1–100                                                                   |
| `status`         | query | enum   | no       | active     | `open` \| `pending` \| `resolved` \| `closed`. One value, not a list    |
| `priority`       | query | enum   | no       | —          | `low` \| `normal` \| `high` \| `urgent`                                 |
| `scope`          | query | enum   | no       | `assigned` | `assigned` \| `unassigned` \| `all`                                     |
| `assignedUserId` | query | uuid   | no       | —          | Narrows the scope; never widens it                                      |
| `assignedTeamId` | query | uuid   | no       | —          | Narrows the scope; never widens it                                      |
| `routingState`   | query | enum   | no       | —          | `pending` \| `assigned` \| `deferred` \| `manual`. `deferred` re-orders |
| `deferredReason` | query | enum   | no       | —          | `all_at_capacity` \| `none_available` \| `no_candidate_pool`            |
| `breachedOnly`   | query | bool   | no       | `false`    | Tickets whose SLA has breached                                          |

```bash
curl -b cookies.txt 'http://northwind.app.localhost:3051/api/v1/tickets?scope=all&limit=1'
```

```json
{
  "items": [
    {
      "id": "0192f008-0000-7000-8000-000000000801",
      "number": 1,
      "conversationId": "0192f004-0000-7000-8000-000000000401",
      "contactId": "0192f003-0000-7000-8000-000000000301",
      "subject": "July invoice and card change",
      "status": "open",
      "priority": "high",
      "assignedUserId": "0192f001-0000-7000-8000-000000000101",
      "assignedTeamId": "0192f002-0000-7000-8000-000000000201",
      "routing": {
        "state": "pending",
        "deferredReason": null,
        "deferredSince": null
      },
      "sla": {
        "policyId": "01a002cd-0a7f-7599-8a2b-279c225661fc",
        "firstResponseState": "met",
        "firstResponseDueAt": "2026-08-14T22:23:06.911Z",
        "resolutionState": "not_applicable",
        "resolutionDueAt": null
      },
      "firstRespondedAt": "2026-08-14T21:28:06.911Z",
      "resolvedAt": null,
      "closedAt": null,
      "createdAt": "2026-08-14T21:23:06.911Z",
      "updatedAt": "2026-08-15T00:23:07.233Z"
    }
  ],
  "nextCursor": "eyJ2IjoxLCJrIjpbImhpZ2giLCIyMDI2LTA4LTE0VDIxOjIzOjA2LjkxMVoiXSwiaWQiOiIwMTkyZjAwOC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMDA4MDEifQ"
}
```

`nextCursor` is `null` on the last page. Pass it back as `?cursor=…` for the next one; it
is opaque and versioned, and a cursor minted by a list with a different sort key is refused
rather than silently paged from the wrong place.

Six behaviours a client cannot read off the parameter table:

- **Resolving a ticket removes it from this list with no client change.** That is the whole
  mechanism behind "a resolved ticket leaves the active queue": the row stops matching the
  default filter. A finished ticket is still readable — ask for it by name with
  `?status=resolved` or `?status=closed`.
- **There is no way to ask for every status at once.** `status` takes one value. Widening it
  to a list, or adding `status=all`, is additive and is the recorded follow-up for when a
  "closed tickets" view is asked for.
- **There is no `sort` parameter.** The queue has one order. `priority DESC` is urgent-first
  because `ticket_priority` is declared `low, normal, high, urgent` and Postgres orders an
  enum by declaration order — reordering those labels inverts the queue, which is why
  `schema.prisma` carries a warning and `ticket-queue.int-spec.ts` asserts it. Within a
  priority band, `createdAt DESC` is newest-first.
- **`scope` is narrowed, not refused.** A caller without `ticket:read_all` asking for `all`
  or `unassigned` receives `assigned`, so a supervisor's shared URL renders for an agent
  with less in it rather than answering 403.
- **`routingState=deferred` is the stuck-ticket query** (TAR-274): the tickets routing ran on
  and could place with nobody. The router writes the column as of TAR-373, so the page carries
  the tickets that are actually stuck, and `routing_deferred_since` is a value the router sets
  once, on the first deferral, and does not move when a job is redelivered. `deferredReason`
  narrows it to one reason. Send it with `scope=all` rather than `scope=unassigned` —
  `unassigned` means "no user **and** no team", and a ticket a rule routed to a team and
  rotation then deferred still carries `assignedTeamId`, which is exactly the
  `all_at_capacity` case this query is for.
- **That one query pages in a different order: `routingDeferredSince ASC, id ASC`** — oldest
  stuck first, because this is a triage list and a customer waiting since yesterday outranks
  an urgent ticket flagged a minute ago (ADR 0008 decision 3 and amendment 3). It applies to
  `routingState=deferred` and to any `deferredReason`, and to nothing else. **A cursor cannot
  cross between the two orders**: a deferred cursor carries one sort value and a queue cursor
  carries two, so replaying one against the other is `validation_failed` rather than a page
  from the wrong place. Both orders emit a real `nextCursor` — the flagged queue included, so
  a supervisor with more stuck tickets than fit on a page can reach the rest.

The default page is served by `tickets_active_queue_idx` —
`(tenant_id, priority DESC, created_at DESC, id DESC) WHERE status IN ('open','pending')` —
so it carries no sort over the tenant's active set. The flagged page is served by
`tickets_routing_deferred_idx` — `(tenant_id, routing_deferred_since)
WHERE routing_state = 'deferred'` — which supplies the predicate and the leading sort key,
leaving the `id` tie-break as an incremental sort inside one millisecond. A request with an
explicit non-active `status`, or a scoped queue, falls back to a bounded sort.

| Status | Code                | Cause                                                                              |
| ------ | ------------------- | ---------------------------------------------------------------------------------- |
| `200`  | —                   |                                                                                    |
| `400`  | `validation_failed` | `limit` out of range, a filter outside its enum, or a cursor this build cannot use |
| `401`  | `unauthenticated`   | No usable session                                                                  |
| `403`  | `forbidden`         | Caller lacks `ticket:read`. No shipped role is in this case                        |

## `GET /api/v1/tickets/{id}`

One ticket, in the same shape the list and the `PATCH` publish.

| Parameter | In   | Type | Required | Default | Notes                             |
| --------- | ---- | ---- | -------- | ------- | --------------------------------- |
| `id`      | path | uuid | yes      | —       | Validated before anything is read |

```bash
curl -b cookies.txt \
  'http://northwind.app.localhost:3051/api/v1/tickets/0192f008-0000-7000-8000-000000000803'
```

```json
{
  "id": "0192f008-0000-7000-8000-000000000803",
  "number": 3,
  "conversationId": "0192f004-0000-7000-8000-000000000403",
  "contactId": "0192f003-0000-7000-8000-000000000303",
  "subject": "Activation link keeps expiring",
  "status": "open",
  "priority": "high",
  "assignedUserId": "0192f001-0000-7000-8000-000000000104",
  "assignedTeamId": "0192f002-0000-7000-8000-000000000202",
  "routing": {
    "state": "pending",
    "deferredReason": null,
    "deferredSince": null
  },
  "sla": {
    "policyId": "01a002cd-0a7f-7599-8a2b-279c225661fc",
    "firstResponseState": "breached",
    "firstResponseDueAt": "2026-08-13T19:23:06.911Z",
    "resolutionState": "not_applicable",
    "resolutionDueAt": null
  },
  "firstRespondedAt": null,
  "resolvedAt": null,
  "closedAt": null,
  "createdAt": "2026-08-13T18:23:06.911Z",
  "updatedAt": "2026-08-15T00:23:07.233Z"
}
```

Four fields behave in ways the shape does not show:

- **`sla` is derived from the ticket's timers, not stored on the ticket.** Each target
  reports one of `not_applicable`, `running`, `paused`, `met` or `breached`, with the
  deadline beside it. A target with no timer is `not_applicable` with a null deadline, and
  so is a cancelled one — `SLA_STATES` publishes no `cancelled`, and "there is no deadline
  here" is what a badge needs to know. `policyId` is null for a tenant with SLA turned off.
  No deadline is copied onto `tickets` deliberately: `dueAt` moves on every pause and
  resume, so a copy would drift into reporting a breach that never happened. Where the window
  comes from, what moves a timer, and who is alerted when one breaches are in
  [the SLA timers reference](sla-timers.md).
- **`routing` says whether routing may still act on this ticket**, and is not part of its
  lifecycle. `state` is `pending`, `assigned`, `deferred` or `manual`; `deferredReason` and
  `deferredSince` are non-null exactly when it is `deferred`. `RuleEngineService` writes it in
  the branch that decided it (TAR-373) and `POST /tickets/{id}/assign` writes it on a manual
  placement (TAR-374); a ticket a backfill classified `manual` keeps that. `pending` means the
  routing job has not reached a conclusion, and it is reachable again after a release —
  [ADR 0008 amendment 2](../architecture/0008-assignment-rotation-and-workload.md#amendment-2--how-post-apiv1ticketsidassign-behaves-tar-374).
- **`subject` is null on an auto-created ticket.** The first inbound message is as likely to
  be an image or a sticker as a sentence, so there is nothing honest to derive a subject
  from. Clients fall back to `number`, which is what agents and customers quote anyway.
- **`firstRespondedAt` is stamped by the first reply from a person** on the ticket's
  conversation — the same event that stops the first-response timer. A bot reply writes no
  sender and does not stop the clock, so it does not fill this field either.

`number` is per-tenant and sequential. Two tenants both holding ticket #1 is correct.

| Status | Code                | Cause                                                      |
| ------ | ------------------- | ---------------------------------------------------------- |
| `200`  | —                   |                                                            |
| `400`  | `validation_failed` | `id` is not a UUID                                         |
| `401`  | `unauthenticated`   | No usable session                                          |
| `403`  | `forbidden`         | Caller lacks `ticket:read`                                 |
| `404`  | `not_found`         | Absent, another tenant's, or not visible to this principal |

## `PATCH /api/v1/tickets/{id}`

Changes a ticket's subject, status and priority. One endpoint for all three, because a
status change and a re-prioritisation are one triage action an agent takes in one form —
unlike a conversation's status, which has its own sub-route.

**Authentication.** Session cookie, as above. `ticket:update`, plus `ticket:close` for a
transition into `resolved` or `closed`.

**Idempotency.** No `Idempotency-Key`. The body carries the target state, so replaying a
request is the [no-op](#setting-the-value-a-ticket-already-has-is-a-no-op) below rather than
a second effect.

| Parameter  | In   | Type   | Required | Default | Notes                                           |
| ---------- | ---- | ------ | -------- | ------- | ----------------------------------------------- |
| `id`       | path | uuid   | yes      | —       |                                                 |
| `subject`  | body | string | no       | —       | 1–200 characters. No transition rules, no event |
| `status`   | body | enum   | no       | —       | `open` \| `pending` \| `resolved` \| `closed`   |
| `priority` | body | enum   | no       | —       | `low` \| `normal` \| `high` \| `urgent`         |

**At least one of the three is required.** An empty body is `validation_failed`: `{}` is a
client bug with no honest answer, and accepting it as a 200 would report success for a
request that asked for nothing.

```bash
curl -b cookies.txt -X PATCH \
  'http://northwind.app.localhost:3051/api/v1/tickets/0192f008-0000-7000-8000-000000000803' \
  -H 'Content-Type: application/json' \
  -d '{"priority":"urgent"}'
```

```json
{
  "id": "0192f008-0000-7000-8000-000000000803",
  "number": 3,
  "status": "open",
  "priority": "urgent",
  "routing": { "state": "pending", "deferredReason": null, "deferredSince": null },
  "resolvedAt": null,
  "closedAt": null,
  "updatedAt": "2026-08-15T00:24:16.282Z"
}
```

The response is the whole `TicketResponse`, abbreviated above to the fields that moved.

### Which status moves are allowed

From (row) to (column), for an agent through this endpoint:

|              | → open | → pending | → resolved | → closed |
| ------------ | ------ | --------- | ---------- | -------- |
| **open**     | no-op  | ✅        | ✅         | ✅       |
| **pending**  | ✅     | no-op     | ✅         | ✅       |
| **resolved** | ❌     | ❌        | no-op      | ✅       |
| **closed**   | ❌     | ❌        | ❌         | no-op    |

The ❌ cells answer `409 conflict`. **`resolved` and `closed` are terminal-for-active:
nothing re-activates them.** Two reasons, and the first is load-bearing:

- `tickets_one_active_per_contact` is a partial unique index over
  `status IN ('open','pending')`. A contact whose resolved ticket is re-activated may
  already hold a new active one, so the UPDATE would raise a unique violation that reaches
  the client as `internal_error`. Refusing the transition is the same answer, correctly
  coded.
- There is no reopen window at v1. A customer writing back after resolution gets a **new**
  ticket, by design ([ADR 0003](../architecture/0003-ticket-auto-linking-contract.md)), and
  adding one through an agent-initiated `PATCH` would ship half of it.

`open → closed` is allowed and does not pass through `resolved`: closing spam or a wrong
number is not a resolution, and forcing the two-step would put a fake resolution time on
every one of them.

**Do not re-type this table.** `TICKET_STATUS_TRANSITIONS` and `canAgentTransition(from, to)`
in `packages/contracts/src/tickets.ts` are the single published copy — the console disables
the moves the API refuses by reading them, and a second copy that drifts is a UI offering a
move the API rejects.

### Setting the value a ticket already has is a no-op

A `PATCH` whose `status` or `priority` equals the current value returns `200` with the
current ticket, writes nothing, and appends no event — `updatedAt` does not move. A
double-clicked button and a retry after a dropped response both arrive as "set resolved" on
a ticket that is already resolved, and answering 409 would show a failure for a request that
achieved exactly what was asked. `PATCH` is defined by the target state, not by the delta.

What is refused is only what the table above marks ❌, and it is refused with a coded error
rather than silently accepted.

### `resolvedAt` and `closedAt`

Both are written on the transition **into** the state, never derived from it and never
cleared:

| Transition                       | `resolvedAt`                            | `closedAt`             |
| -------------------------------- | --------------------------------------- | ---------------------- |
| `open`/`pending` → `resolved`    | set to now                              | untouched (stays null) |
| `resolved` → `closed`            | **untouched** — keeps the original time | set to now             |
| `open`/`pending` → `closed`      | **left null**                           | set to now             |
| `pending` → `open` (auto-reopen) | untouched                               | untouched              |
| any no-op                        | untouched                               | untouched              |

A ticket closed without being resolved keeps `resolvedAt: null` deliberately. Back-filling
it would manufacture a resolution that never happened, and cycle-time reporting (TAR-30)
reads that column — `closedAt IS NOT NULL AND resolvedAt IS NULL` is the honest signal for
"closed unworked".

Re-resolving cannot overwrite a resolution time. `resolved → resolved` is a no-op and
`resolved → open` is refused, so at v1 the value is written exactly once.

### Losing a race answers `conflict`

The write is a compare-and-set on `status`: the `UPDATE` carries `WHERE status = <the status
read moments earlier>`, and a zero-row match is `409 conflict`. There is no version column,
because `status` _is_ the state the transition rules are about.

The realistic cause is the one this endpoint exists around — **the customer replied and the
ticket auto-reopened from `pending` to `open` while the agent was resolving it**. The
service deliberately does not retry the transition against the new status: re-applying
"resolve" from `open` would satisfy the click and hide the fact that the customer just
wrote, which is the one thing the agent needs to know before resolving. Refetch, show the
new message, and let them decide again.

The mirror ordering is equally consistent: if the agent's `pending → resolved` commits
first, the reopen matches nothing and the customer's reply **opens a new ticket** for the
contact. That is the designed no-reopen-window behaviour, not a defect.

### Errors

| Status | Code                | Cause                                                                         | Message                                                                                        |
| ------ | ------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `200`  | —                   | Applied, or accepted as a no-op                                               |                                                                                                |
| `400`  | `validation_failed` | Empty body, a field outside its enum or length, or an `id` that is not a UUID | Carries `details`                                                                              |
| `401`  | `unauthenticated`   | No usable session                                                             |                                                                                                |
| `403`  | `forbidden`         | `→ resolved` or `→ closed` without `ticket:close`                             | `Marking a ticket resolved needs the ticket:close permission.`                                 |
| `404`  | `not_found`         | Absent, another tenant's, or not visible to this principal                    | `No ticket matches that id.`                                                                   |
| `409`  | `conflict`          | A transition the table refuses                                                | `A resolved ticket cannot be moved to open.`                                                   |
| `409`  | `conflict`          | The compare-and-set matched nothing — the status moved underneath             | `This ticket is no longer pending — somebody or something changed it while you were working.…` |

`forbidden` for a missing `ticket:close` is the one place this surface answers 403 rather
than 404, and it is not a contradiction: by the time it is raised the caller has passed the
visibility check, so the ticket's existence is not a secret from them. What is refused is
the act.

```json
{
  "error": {
    "code": "conflict",
    "message": "A resolved ticket cannot be moved to open.",
    "requestId": "eead1212-9671-4c1f-86e4-8233567f2cb5"
  }
}
```

No new error codes were added for this surface; every refusal maps onto the taxonomy in
`packages/contracts/src/error-codes.ts`.

### A status change moves the SLA timers

A `PATCH` that changes `status` enqueues an SLA evaluation on the `sla` queue after the
transaction commits, so the ticket's timers pause, resume, stop or are cancelled to match
the new state. A priority or subject edit enqueues nothing: a running deadline keeps the
policy it started under.

The evaluation is a durable job rather than an in-process event, because a missed SLA
transition leaves a paused clock running against an agent or a breach nobody is told about,
with nothing recording that it was lost. It is also **asynchronous**: the `sla` block in the
response is read before the evaluation runs, so a client that resolves a ticket and reads
the resolution state in the same breath may see the timer's previous state. Refetch if the
badge matters.

Failing to enqueue does not fail the request — the status change is committed and the caller
is owed their 200 — but it is logged as a warning naming the ticket and the transition.

## `POST /api/v1/tickets/{id}/assign`

Puts a name on a ticket, takes it off somebody, or releases it back to nobody. This is the
write that empties the flagged queue: a ticket rotation could not place stays there until a
person places it (TAR-374; the algorithm that flagged it is
[the auto-assignment reference](auto-assignment.md)).

**Authentication.** Session cookie, as above. `ticket:assign` — supervisor and above.

**Idempotency.** No `Idempotency-Key`. The body carries the target assignment rather than a
delta, so a repeated submit is the [no-op](#a-repeated-submit-writes-nothing) below.

`200`, not `201`: nothing is created, and the body is the ticket as it now stands — the same
`TicketResponse` the detail read and the `PATCH` publish, so a client can put the response
straight back into its cache.

| Parameter | In   | Type       | Required | Default | Notes                                            |
| --------- | ---- | ---------- | -------- | ------- | ------------------------------------------------ |
| `id`      | path | uuid       | yes      | —       | Validated before anything is read                |
| `userId`  | body | uuid\|null | no       | —       | Absent leaves the column alone; `null` clears it |
| `teamId`  | body | uuid\|null | no       | —       | Absent leaves the column alone; `null` clears it |
| `reason`  | body | string     | no       | —       | Up to 500 characters. Recorded on the event log  |

**At least one of `userId` and `teamId` is required.** A body carrying neither — `{}`, or
`reason` on its own — is `validation_failed`.

**The update is partial, and that is the whole reason there is no route per direction.** One
call can hand a ticket to a named agent inside the team it already belongs to, move it from
an agent to a team, or release it, depending on which of the two fields the body carries.
Omitting a field is not the same as sending `null` for it.

```bash
curl -b cookies.txt -X POST \
  'http://northwind.app.localhost:3051/api/v1/tickets/0192f008-0000-7000-8000-000000000803/assign' \
  -H 'Content-Type: application/json' \
  -d '{"userId":"0192f001-0000-7000-8000-000000000101","reason":"Covering while Liang is offline"}'
```

```json
{
  "id": "0192f008-0000-7000-8000-000000000803",
  "number": 3,
  "subject": "Activation link keeps expiring",
  "status": "open",
  "priority": "high",
  "assignedUserId": "0192f001-0000-7000-8000-000000000101",
  "assignedTeamId": "0192f002-0000-7000-8000-000000000202",
  "routing": { "state": "manual", "deferredReason": null, "deferredSince": null },
  "updatedAt": "2026-08-15T12:45:51.156Z"
}
```

The response is the whole `TicketResponse`, abbreviated above to the fields that moved.
`assignedTeamId` survived because the body did not carry `teamId`.

### What it writes to `routing`

| Body leaves the ticket with | `routing.state` | The two deferred fields |
| --------------------------- | --------------- | ----------------------- |
| A user, a team, or both     | `manual`        | cleared                 |
| Neither                     | `pending`       | cleared                 |

**`manual` is terminal for routing.** No background job assigns the ticket again — a
re-route overruling a supervisor who deliberately placed or parked a ticket is the kind of
behaviour that gets a feature switched off.

**An explicit release goes to `pending`, not `manual`,** and this is the one rule on this
endpoint worth reading twice. A body leaving the ticket with neither a user nor a team
returns it to the state a fresh ticket has: nobody holds it, and no supervisor has judged it
stuck. It stays out of the flagged queue, because releasing a ticket on purpose is not
rotation failing to place one. So **`pending` is reachable after the insert** — it is not an
insert-only value, whatever the column default suggests
([ADR 0008 amendment 2](../architecture/0008-assignment-rotation-and-workload.md#amendment-2--how-post-apiv1ticketsidassign-behaves-tar-374)).

The four assignment and routing columns move in **one statement**, and the event is appended
inside the same transaction. That is not a preference:
`tickets_routing_deferred_consistent` makes `routing_state = 'deferred'` equivalent to both
deferred columns being non-null, so a deferred ticket cannot leave that state unless the
same write nulls them — and an event log claiming an assignment the constraint then rejected
would be worse than no log.

### Last writer wins

There is no compare-and-set here, unlike the `PATCH`. Nothing else writes the assignment
columns behind this route except the router, and the router only ever moves a ticket **out
of** unassigned. Two supervisors placing the same flagged ticket in the same second is a race
whose honest answer is "the later one holds it", and both are on the event log either way.

### A repeated submit writes nothing

A second identical submit returns `200` with the current ticket, writes no columns and
appends no event — `updatedAt` does not move. A double-clicked **Assign** button and a retry
after a dropped response both arrive as this, and each would otherwise put another `assigned`
row in the history an escalation is read from.

The comparison covers the routing columns as well as the assignment ones, so assigning a
_deferred_ ticket to the team it already carries is a no-op on the assignment and still moves
the ticket to `manual` and out of the flagged queue.

### Errors

| Status | Code                | Cause                                                                        | Message                                                   |
| ------ | ------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| `200`  | —                   | Applied, or accepted as a no-op                                              |                                                           |
| `400`  | `validation_failed` | Neither `userId` nor `teamId`, a `reason` over 500 characters, or a bad `id` | Carries `details`                                         |
| `400`  | `validation_failed` | `userId` or `teamId` does not name an **active** user or team in this tenant | `… does not name an active user in this tenant.`          |
| `401`  | `unauthenticated`   | No usable session                                                            |                                                           |
| `403`  | `forbidden`         | Caller lacks `ticket:assign` — every agent                                   | `This account does not have permission to ticket:assign.` |
| `404`  | `not_found`         | Absent, another tenant's, or not visible to this principal                   | `No ticket matches that id.`                              |

**A body naming an assignee this tenant does not have is `validation_failed`, not
`not_found`.** The ticket the caller addressed _was_ found; what is wrong is a field of the
body, and a 404 here would read as "the ticket is gone" — which is the answer a console
reacts to by dropping the row and refetching, the wrong recovery for a stale name in a
dropdown. The `details` entry names `userId` or `teamId` so the dialog can highlight the
input.

```json
{
  "error": {
    "code": "validation_failed",
    "message": "0192f001-0000-7000-8000-000000000105 does not name an active user in this tenant.",
    "details": [
      {
        "path": "userId",
        "message": "0192f001-0000-7000-8000-000000000105 does not name an active user in this tenant."
      }
    ],
    "requestId": "2bfd9fe6-9a58-4354-a760-94da8b0473c1"
  }
}
```

**A user in another tenant and a user who is not `active` fold into the same refusal.** The
first is invisible under row-level security and the second is refused by the same lookup, so
the message cannot be used to learn that a UUID names somebody real elsewhere. `invited`,
`suspended` and `removed` accounts are all refused: handing a stuck ticket to one would look
like a fix and be a second deferral.

The assignee lookup runs **outside** the transaction, knowingly. A user suspended in the
milliseconds between the check and the write lands assigned, which a supervisor or the next
routing pass corrects; a lock spanning the two would be a heavier cure than the disease.

### What this endpoint does not do

- **It does not announce anything.** No `ticket.updated` — that event carries status and
  priority, neither of which moved — and no realtime push. The console refetches.
- **It does not move an SLA timer.** The fourth SLA trigger is a **status** change; a
  deadline does not shift because a ticket changed hands.
- **It does not check capacity.** A supervisor may hand a ticket to an agent already at their
  concurrent-ticket cap, and the console says so on the dialog. The cap governs _rotation_,
  not a person's judgement.
- **It writes no `audit_logs` row.** Assignment is ordinary operational activity;
  `ticket_events` is the per-ticket history.

### What lands in the event log

| Body leaves the ticket with | `type`       | `data`                                                                                                        | `actorUserId`  |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- | -------------- |
| An assignee                 | `assigned`   | `{ assignedUserId, assignedTeamId, previousAssignedUserId, previousAssignedTeamId, cause: "agent", reason? }` | the supervisor |
| Nobody                      | `unassigned` | the same shape                                                                                                | the supervisor |

`reason` appears only when the body carried one. The two `previous…` fields are on this
event and not on the router's `assigned`: the router only ever assigns a ticket nobody holds,
whereas a supervisor's re-assignment is exactly the case where "who had it before" is the
interesting half.

`actorUserId` is the calling principal here, unlike every routing event, where it is null
because a queue worker has no principal.

## Auto-reopen: what an API consumer observes

**A customer replying to a `pending` ticket reopens it to `open`, with no agent action and
no request.** It is not a route — nothing calls it, and no client can trigger it.

The mechanism, as shipped: TAR-20's inbound writer enqueues `ticket.ensure-for-message`
after the message row commits; `TicketQueueRunner` consumes it in tenant scope;
`TicketLinkerService` finds the contact's active ticket and, if it is `pending`, moves it to
`open` under the same compare-and-set the `PATCH` uses.

Four consequences for a client:

- **It is eventually consistent, not immediate.** The reopen lands on a durable queue rather
  than in the request that wrote the message. A queue outage delays reopens; it does not
  lose them.
- **Nothing is pushed.** `realtime.ts` publishes a `ticket.updated` server event and nothing
  emits it yet — wiring the socket relay needs a ticket-specific audience room, which TAR-25
  deliberately did not amend. The console refetches the queue on view and after its own
  mutation, and an auto-reopen becomes visible on the next refetch.
- **The ticket is found by contact, not by conversation.** A tenant running two WhatsApp
  numbers gets the right result: a reply arriving on a _different_ conversation of the same
  contact still reopens the one active ticket, appending `conversation_linked` rather than
  moving `conversationId`.
- **It is a system actor.** `actorUserId` is null on the event it writes, and no permission
  check applies — there is no principal on a queue worker.

## What lands in the event log

Every status or priority change appends one row to `ticket_events`. That log is what makes
TAR-32's escalation history and TAR-30's cycle-time reporting derivable rather than
separately maintained.

| Change                          | `type`             | `data`                                                      | `actorUserId` |
| ------------------------------- | ------------------ | ----------------------------------------------------------- | ------------- |
| Agent changes status            | `status_changed`   | `{ from, to, cause: "agent" }`                              | the agent     |
| Agent changes priority          | `priority_changed` | `{ from, to, cause: "agent" }`                              | the agent     |
| Customer reply reopens a ticket | `status_changed`   | `{ from: "pending", to: "open", cause: "inbound_message" }` | `null`        |
| Agent changes subject           | — none             | —                                                           | —             |

Two rules worth holding on to:

- **`reopened` is reserved and is written by nothing.** The customer-reply reopen is a
  `status_changed` carrying `cause: "inbound_message"`, which is what the linker has written
  since TAR-21. Two event types meaning "the status moved" would make every consumer learn
  both, and the `reopened` name belongs to the `resolved →` reopen window that does not
  exist at v1. The distinction a client needs is `cause` plus a null actor; the console
  renders that pair as **"Reopened — customer replied"**.
- **Ticket changes are not written to `audit_logs`.** That trail carries security-relevant
  events, and ordinary triage happening hundreds of times a day per tenant would drown it.
  `ticket_events` is the per-ticket history.

`cause` is published on `TicketEventSchema` as `TICKET_EVENT_CAUSES` — `agent`,
`inbound_message`, `automation`, `sla` — and is nullable for the event types that predate
it. It is deliberately separate from `reason`, which is agent-supplied free text: a machine
token hidden in prose would force the console to string-match.

Reading the log over HTTP is `GET /api/v1/tickets/{id}/events`, which **is not implemented
yet** (TAR-32). It is published in ADR 0002's endpoint table and additive to this
controller.

## Tenant isolation

Every statement runs on `TenantPrisma`, so `app.tenant_id` is set and row-level security
(RLS) supplies the tenant equality — no service on this surface takes a `tenantId`
parameter. What the services add is the intra-tenant question RLS cannot answer: which of
this tenant's tickets this principal may see.

| Attempt                                             | Answer                                    |
| --------------------------------------------------- | ----------------------------------------- |
| Read another tenant's ticket by id                  | `404 not_found`                           |
| `PATCH` another tenant's ticket by id               | `404 not_found`, and the row is unchanged |
| List tickets from another tenant's host             | Only that tenant's own queue              |
| Read a colleague's ticket without `ticket:read_all` | `404 not_found`                           |

The system reopen holds a tenant and no principal by construction, so it cannot be a
permission bypass: a permission check on a queue worker would throw rather than be lenient.

## What is not on this surface

- **`GET /api/v1/tickets/{id}/events`** (TAR-32) — the event-log read.
- **Creating a ticket over HTTP.** Tickets are opened by the inbound-message linker
  ([ADR 0003](../architecture/0003-ticket-auto-linking-contract.md)).
- **Realtime `ticket.updated`.** Published in `realtime.ts`, emitted by nothing.
- **Writing `routing.state` through the queue or the `PATCH`.** The block is read from the
  row on both. Its writers are `RuleEngineService` (TAR-373) and the assign route above
  (TAR-374); no other route on this page sets it.
- **Choosing an assignee automatically.** Rules and rotation do that off a queue, before any
  supervisor sees the ticket — [the auto-assignment reference](auto-assignment.md).
- **Editing an agent's concurrent-ticket cap.** Specified but not built; the same reference
  says where it would live.
- **Changing an SLA policy.** `GET`/`PATCH /api/v1/sla-policies` and the alert routes are
  their own surface (TAR-280). This one only reports the timers and moves them on a status
  change.

## Verification

Every request and response on this page was executed against a local stack: `docker compose
up -d --wait`, `pnpm db:migrate:deploy`, `pnpm db:roles`, `pnpm db:roles:login`,
`pnpm db:seed`, then the built API on port `3051`. Ids, timestamps and request ids are the
values that run returned. The queue, read and `PATCH` sections were run from `main` at
`21af387`; the assign section was re-run from `main` at `fd5b412`, which is the first commit
where that route exists.

⚠️ **The stack ran with `AUTH_STUB_ENABLED=true`** — the interim role stub, driven by
`x-dev-role` — rather than with real session cookies, because seeded users carry no password
hash and this page needed a principal in each role. The stub resolves a real seeded user and
materialises its permissions from `ROLE_PERMISSIONS`, so what was exercised is the real
permission matrix; what was **not** exercised is session issue and revocation, which
[`people-api.md`](people-api.md#verification) covers.

Confirmed rather than assumed:

- The active queue excludes `resolved` and `closed` without being asked to, and a resolved
  ticket is still readable through `?status=resolved`.
- `priority DESC` puts `urgent` above `high`; setting a priority to `urgent` re-sorts the
  page.
- Keyset paging across two pages returns each ticket exactly once, and `nextCursor` is null
  on the last page.
- A cursor that does not decode, and one carrying the wrong number of sort values, are both
  `400 validation_failed` on `path: "cursor"` — never a silent first page.
- Resolving records `resolvedAt` and removes the ticket from the active queue; closing it
  afterwards sets `closedAt` and **keeps** the original `resolvedAt`.
- `resolved → open` and `closed → open` are `409 conflict`.
- A repeated `PATCH` with the priority the ticket already holds returns 200, leaves
  `updatedAt` unmoved and writes no `ticket_events` row.
- An empty body is `400 validation_failed`; an `id` that is not a UUID is refused before
  anything is looked up.
- The event log after an agent resolve-then-close carries exactly one `priority_changed` and
  two `status_changed` rows, each with `{ from, to, cause: "agent" }` and a non-null actor.
- Another tenant's ticket answers `404 not_found` on both the read and the `PATCH`, and the
  row is untouched afterwards.
- `sla` carries real timer states — a `met` first response with its deadline on one ticket,
  a `breached` one on another — and `breachedOnly=true` returns exactly the breached ticket.
- `routing` renders on every ticket as `pending` with both deferred fields null, and
  `?routingState=deferred` returns an empty page. A `routingState` outside its enum is
  `400 validation_failed` on `path: "routingState"`. **Superseded in part by TAR-373**: the
  router writes the column now, so a deferred ticket reads `deferred` and appears in that
  page. The validation half stands, and the empty page is what a seeded tenant is expected to
  return — only a routing job produces a deferred row.

Confirmed by hand for the assign route:

- Assigning to a user answers `200` with `routing.state: "manual"` and **keeps**
  `assignedTeamId`, because the body carried no `teamId`. Assigning to a team is the mirror.
- Releasing with `{"userId": null, "teamId": null}` answers `200`, nulls both assignment
  columns and leaves `routing.state: "pending"` — the amendment 2 rule, against a real CHECK
  constraint.
- Re-sending an identical body answers `200` and leaves `updatedAt` unmoved.
- A `userId` from the neighbouring tenant and an `invited` user in this one produce the
  **same** `400 validation_failed` on `path: "userId"`, word for word.
- `{}` is `400 validation_failed` carrying `Provide at least one of userId or teamId`; an
  `id` that is not a UUID is refused before anything is looked up.
- An agent is `403 forbidden`; a supervisor of the other tenant reaching this ticket by id is
  `404 not_found`.

Exercised by integration test rather than by hand, because they need a deferred row that only
a routing job writes: a flagged ticket leaving the queue on assignment, both routes out of
`deferred` passing `tickets_routing_deferred_consistent`, the `assigned` and `unassigned`
events with their `previous…` fields, and the cross-tenant refusal under RLS —
`ticket-assign.int-spec.ts`.

Exercised by integration test rather than by hand, because each needs an inbound message
through the queue, two writers colliding, or a routing state the seed does not produce:

- The auto-reopen itself, its `cause: "inbound_message"` event and the absence of a second
  ticket — `ticket-queue.int-spec.ts`, "the customer replying to a pending ticket".
- Both orderings of the reopen race, including that the agent-wins ordering opens a second
  ticket — same file, "the reopen race".
- `403 forbidden` for a principal holding `ticket:update` but not `ticket:close`. No shipped
  role is in that position, so it cannot be produced against a seeded tenant.
- The flagged queue — its oldest-stuck-first order, `deferredReason`, paging across a
  same-millisecond tie, the two cursor arities refusing each other, and one tenant's stuck
  tickets staying invisible to the other — `ticket-flagged-queue.int-spec.ts`. The seed writes
  no deferred ticket — only a routing job does — so the fixture sets the three columns itself
  and every case runs against a real database rather than a stubbed page.
