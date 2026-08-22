# Auto-assignment reference

How a ticket nobody's routing rule claimed reaches an agent, and what happens when it
cannot. Written for engineers building against the API, reading the routing code, or
operating it.

**Auto-assignment** is the rotation that runs when no routing rule matched a new ticket. It
picks the least-loaded eligible agent, takes turns between agents who are equally loaded,
and — when nobody is eligible — leaves the ticket unassigned and **flags it for supervisor
attention** rather than handing it to somebody who cannot work it.

The selection rule lives in `apps/api/src/assignment/rotation-fallback.resolver.ts`, the
numbers in `packages/contracts/src/assignment.ts`, and the columns it reads and writes in
`apps/api/prisma/schema.prisma`. The design and its rejected alternatives are
[0008 — assignment rotation, workload limits and the supervisor's deferred queue](../architecture/0008-assignment-rotation-and-workload.md);
the pipeline it plugs into is
[0007 — routing rules and the assignment-fallback seam](../architecture/0007-routing-rules-and-assignment-fallback.md).
Read 0007 first if you are changing either.

Two neighbouring pages own the halves this one deliberately does not repeat: rule
evaluation and the CRUD around it are
[the assignment rules API reference](assignment-rules-api.md), and the HTTP surface — the
flagged queue and the manual placement — is [the tickets API reference](tickets-api.md).
For supervisors clearing the flagged queue in the console rather than over HTTP, read
[Clear tickets nobody could take](../guides/clear-flagged-tickets.md).

## Where rotation sits

Rotation is not a route and no client can call it. It runs inside the routing job
`TicketsModule` enqueues after a ticket-creating transaction commits, and it is reached only
when rule evaluation produced no match.

```text
ticket created  →  assignment.route-ticket job  →  RuleEngineService
                                                     ├─ a rule matched      → assign its target, stop
                                                     ├─ already assigned    → skip
                                                     └─ no rule matched     → RotationFallbackResolver
                                                                                ├─ somebody eligible → assigned
                                                                                └─ nobody eligible   → deferred
```

Three consequences a client sees, all inherited from the queue and none of them specific to
rotation:

- **Assignment is eventually consistent with the ticket.** Normally sub-second; during a
  Redis outage, as late as the queue's recovery. A UI that assumes a ticket is born assigned
  is wrong.
- **With `REDIS_URL` unset no worker starts.** Tickets are still created and nothing is
  routed by rule or by rotation. The API logs that once, loudly, at boot.
- **Routing is evaluated once, at ticket creation.** Later messages re-route nothing, and
  neither does capacity freeing up later — see [what is not built](#what-is-not-built).

**Rotation decides; it does not assign.** `resolveFallbackAssignment` returns a decision and
writes exactly one row — the rotation cursor. `RuleEngineService` performs the compare-and-set
that records the assignment, appends the ticket event and writes `tickets.routing_state`. The
split is 0007 decision 5, and it is what lets a supervisor's manual assignment win a race
against the worker.

## Eligibility is four predicates

TAR-23 defines "available" as _logged in and under a configurable max concurrent ticket
count_. Taken literally that is two predicates; rotation applies four.

| #   | Predicate                                                   | Column                                    |
| --- | ----------------------------------------------------------- | ----------------------------------------- |
| 1   | The account can log in at all                               | `users.status = 'active'`                 |
| 2   | The agent said they are available                           | `users.availability = 'available'`        |
| 3   | The agent has actually been seen inside the presence window | `users.last_seen_at > now() - 15 min`     |
| 4   | The agent is under their cap                                | active assigned tickets `<` effective cap |

`invited`, `suspended` and `removed` accounts fail predicate 1 — routing to an account that
cannot open a session is routing into a void. `away` and `offline` both fail predicate 2;
`users.availability` is set explicitly by the agent and is never inferred from socket
presence.

**Predicate 3 is not in TAR-23's text, and it is the one to know about.** Because
`availability` is only ever written by the agent, an agent who sets `available` on Monday and
shuts the laptop stays `available` for ever, and rotation feeds them a share of every ticket
into a black hole. That is the worse failure of the two, because it is silent — the tickets
look assigned. `users.last_seen_at` is already denormalised onto `users` by the session-touch
path, so the check costs nothing extra. The window is 15 minutes: longer than
`AUTH_POLICY.sessionSlideThrottleMs` (5 minutes), so a working agent cannot age out between
two writes of their own session, and short enough that a closed laptop stops receiving work
inside one coffee break.

A `last_seen_at` of `NULL` fails the comparison and is excluded, which is the right answer
for somebody who has never been seen.

**Predicate 4's "active" is `open` or `pending`** — the same `TICKET_ACTIVE_STATUSES` the
one-active-ticket-per-contact invariant uses. The effective cap is
`coalesce(users.max_concurrent_tickets, tenant_settings.default_max_concurrent_tickets)`: a
per-agent override over the tenant default, with `NULL` meaning inherit, so raising the
tenant default moves everyone who has not been singled out.

### Who is in the pool at all

Decided by the team the ticket carries, which the rule engine passes as
`FallbackAssignmentRequest.teamId`.

| `teamId`                 | Candidate pool                            |
| ------------------------ | ----------------------------------------- |
| A team id                | Members of that team, whatever their role |
| `null` — the tenant pool | Users with `role = 'agent'` only          |

A team id reaches rotation when a rule routed the ticket to a team, or when the ticket
already carried `assigned_team_id`. Inside a team, membership is the statement of intent and
role is not re-checked.

**The tenant pool excludes supervisors deliberately.** A supervisor holds every agent
permission, so without the role filter every tenant's supervisor is silently placed in the
rotation and starts receiving customer tickets between doing their own job. A supervisor who
genuinely works a queue is put in the team that owns it — explicit, audited, and a mechanism
that already exists.

## Selection: least-loaded first, rotation as the tie-break

One `ORDER BY` over the eligible set, and rotation takes the first row under its cap:

```sql
ORDER BY active_count ASC,                      -- load-based
         coalesce(u.id > $cursor, false) DESC,  -- round-robin, with wraparound
         u.id ASC                               -- a total order, always
```

Each key earns its place:

- **`active_count ASC` is the load half.** Work goes to whoever is carrying least.
- **The cursor comparison is the entire rotation, expressed without a loop.** Candidates
  sorting after the cursor come first, so each pick advances around the ring; when none do,
  every row is `false`, the third key applies and the ring wraps to the lowest id. A `NULL`
  cursor — a scope's first ever assignment — makes the comparison `NULL`, the `coalesce`
  turns it into `false` for everyone, and the ring starts at the lowest id. There is no
  special case in the service.
- **`u.id ASC` makes the order total**, which is what makes a test able to assert "these four
  tickets went to these four agents in this order" without stubbing a clock or an RNG.

The ring order is `users.id` ascending, and that is not arbitrary: ids are UUID v7, so
ascending id is the order people joined the tenant. Rotation reads as "round the team in join
order", and it is stable under a rename.

**Why the composition rather than one mode or the other.** With everyone at equal load — the
ordinary morning — the first key is a no-op and this _is_ round-robin, which is what TAR-23's
acceptance criterion literally asks for. The moment loads diverge, because one agent's tickets
are slow to resolve, work goes to whoever has least. Neither mode needs a flag, and no
configuration chooses between them. 0008 decision 2 records why pure round-robin, pure
least-loaded and weighted random were each rejected.

### The cursor is a fairness hint, not a ledger

One `assignment_state` row per **routing scope**, and a scope is a team **or the tenant
pool** — `team_id IS NULL`. The uniqueness that makes the pool one scope rather than five is
`assignment_state_tenant_scope_key`, which is `UNIQUE … NULLS NOT DISTINCT`; without that
clause Postgres would hold any number of tenant-pool cursors quite happily and rotation would
read a different one each time, which does not fail — it silently stops rotating.

The resolver advances the cursor **before** it returns, in its own transaction. The
consequence is stated rather than hidden: the engine's compare-and-set can then fail, because
a supervisor assigned the ticket by hand in the intervening milliseconds, and the cursor names
somebody who was never given that ticket. The next assignment starts one place further round
the ring than it strictly should. That is accepted — one skipped turn is invisible at any
timescale a fairness property is measured over, and the load key corrects for it on the next
ticket.

A cursor naming a departed user is equally harmless: it is only ever compared with `>`, never
dereferenced. Do not "fix" it into a join.

## The numbers

`ASSIGNMENT_POLICY` in `packages/contracts/src/assignment.ts` is the single published copy —
the API enforces these, the console renders copy from them, and the test suite asserts against
them.

| Constant                      | Value    | Meaning                                                          |
| ----------------------------- | -------- | ---------------------------------------------------------------- |
| `defaultMaxConcurrentTickets` | `5`      | The cap used when `tenant_settings` has no row yet               |
| `minMaxConcurrentTickets`     | `1`      | Floor on both the tenant default and a per-agent override        |
| `maxMaxConcurrentTickets`     | `1000`   | Ceiling on both                                                  |
| `presenceWindowMs`            | `900000` | How stale `users.last_seen_at` may be and still count as present |

**Five is a defensible starting value, not a measured one**, and the presence window is the
one product-visible number this design invents. Both are one value in one place precisely so
they can be changed on evidence.

The floor is 1 rather than 0 because "route nothing to me" is what `availability = 'away'`
already means, and a second way to say it is a second thing to keep in step. The two bounds
are also the CHECK constraints `users_max_concurrent_tickets_range` and
`tenant_settings_default_max_concurrent_tickets_range` in migration
`20260813140000_assignment_workload_and_routing_state` — the constant and the constraints have
to move together.

### Where a cap is configured

| Scope     | Column                                            | Set by                                               |
| --------- | ------------------------------------------------- | ---------------------------------------------------- |
| Tenant    | `tenant_settings.default_max_concurrent_tickets`  | `PATCH /api/v1/assignment-settings`                  |
| Per agent | `users.max_concurrent_tickets` (`NULL` = inherit) | `maxConcurrentTickets` on `PATCH /api/v1/users/{id}` |

Both writes need **`assignment_rule:write`** — supervisor and admin — rather than
`user:update`. Setting a colleague's cap is deciding how much work reaches them, which is the
same act as writing a routing rule; routing it through `user:update` would mean anyone who may
edit a display name may also quietly stop work reaching a colleague. A body carrying
`maxConcurrentTickets` from a caller without the permission is **refused**, not served with the
field dropped.

Two reads go with them. `GET /api/v1/assignment-settings` is the tenant default —
`assignment_rule:read`, answering the built-in fallback of 5 with `updatedAt: null` for a tenant
that has no settings row rather than a 404. `GET /api/v1/assignment-settings/me` is an agent's
own cap and live load, open to any signed-in principal, and read-only: an agent may see the
limit being applied to them and may not change it. A supervisor reading a colleague's number
gets it as `assignmentCapacity` on `GET /api/v1/users`, which is `null` for anyone without
`assignment_rule:read` or `:write` — every agent holds `user:read`, so an ungated field there
would publish the whole tenant's workload to the whole tenant.

Changes take effect on the **next assignment**, with no restart and no cache to clear: the
resolver's `coalesce` reads both columns per routing job and nothing memoises them. It does not
re-route a ticket that is already deferred — that one stays flagged until somebody assigns it —
so raising a cap frees the agent for the next ticket, not for the one on screen.

The columns and their constraints are described in [the data model reference](data-model.md);
the endpoints are specified in full in 0008
[amendment 4](../architecture/0008-assignment-rotation-and-workload.md#amendment-4--the-cap-editing-surface-built-tar-384),
built by TAR-384.

## When nobody is eligible

The ticket **stays unassigned** and is flagged. This is TAR-23's second acceptance criterion,
and it is deliberately not "give it to somebody anyway": an agent at their cap, or one who
shut their laptop, cannot work a ticket, and an assignment that looks placed is worse than one
visibly stuck.

Two things are written, and both are needed:

| What                                                        | Where           | Says                           |
| ----------------------------------------------------------- | --------------- | ------------------------------ |
| An `assignment_deferred` ticket event                       | `ticket_events` | That the deferral **happened** |
| `routing_state = 'deferred'`, plus a reason and a timestamp | `tickets`       | That it is **still true**      |

An event is an append-only record and cannot be filtered on without a correlated subquery per
row; the column is a single indexed predicate, which is what makes the supervisor's queue a
filter on the ticket list rather than a subsystem of its own. `routing_deferred_since` is a
column of its own because it is what the queue sorts by, and it is not derivable from
`created_at` — a ticket that was assigned, released and then deferred would report an age that
is a lie.

`routing_state` is coarser than the router's four outcomes on purpose. It answers _may routing
still act, and if not why_; _how did this get here_ is the event log's job.

| `routing_state` | Meaning                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `pending`       | Routing has not reached a conclusion. The column default — and reachable again after a release |
| `assigned`      | Routing placed it, by rule or by rotation. The event log says which                            |
| `deferred`      | Routing ran and nobody was eligible. **This is the flag**                                      |
| `manual`        | A person assigned or reassigned it. Routing never touches it again                             |

### The three reasons

The vocabulary is one set across the decision object, the Postgres enum and the event's
`reason`, published as `FALLBACK_ASSIGNMENT_REASONS`.

| Reason              | Fires when                                                           | Who fixes it                                                        |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `all_at_capacity`   | Candidates exist and are present; every one is at their cap          | Wait, raise a cap, or take it yourself                              |
| `none_available`    | Candidates exist in the scope; none is `available` and recently seen | A staffing problem                                                  |
| `no_candidate_pool` | The scope holds no active user who could ever be a candidate         | A configuration problem — an empty team, or a tenant with no agents |

**Precedence, when the truth is mixed** — some candidates at capacity, others away. Evaluated
in this order, first match wins:

1. any present, available candidate exists → `all_at_capacity`
2. any active user is in the scope → `none_available`
3. otherwise → `no_candidate_pool`

`all_at_capacity` wins the first tie because it is the state that resolves itself as tickets
close, and therefore the more useful thing to tell somebody staring at the queue. The second
and third are split because "nobody is online" and "nobody was ever put in this team" need
different people to act; collapsing them sends a supervisor hunting for absent colleagues who
were never configured.

Only the `none_available` / `no_candidate_pool` split costs an extra query, and only on the
failure path — a non-empty candidate set answers the question without one.

### Reading the flagged queue

It is a filter on the ticket list, not a resource of its own:

```bash
curl -b cookies.txt \
  'https://acme.app.example.com/api/v1/tickets?scope=all&routingState=deferred'
```

Two things about that request are easy to get wrong, and both are documented in full on
[the tickets API reference](tickets-api.md#get-apiv1tickets):

- **Send `scope=all`, not `scope=unassigned`.** `unassigned` means no user **and** no team,
  and a ticket a rule routed to a team and rotation then deferred still carries
  `assignedTeamId` — which is exactly the `all_at_capacity` case this query is for.
- **This one query pages oldest-stuck-first** — `routingDeferredSince ASC, id ASC` — rather
  than in the queue's `priority DESC, createdAt DESC, id DESC`. A cursor cannot cross between
  the two orders; replaying one against the other is `validation_failed`.

`?deferredReason=` narrows the page to one reason and keeps the same order. It counts as
pinning the request to the deferred set on its own, because
`tickets_routing_deferred_consistent` makes a non-null reason equivalent to
`routing_state = 'deferred'`.

Reading it needs `ticket:read_all` — supervisor and above — because an unassigned ticket is
triaged work rather than a customer waiting in a pool.

### Clearing a flag

`POST /api/v1/tickets/{id}/assign`, documented on
[the tickets API reference](tickets-api.md#post-apiv1ticketsidassign). It sets
`routing_state = 'manual'`, nulls both deferred columns in the same statement, and the ticket
leaves the flagged queue. Rotation never touches it again — a background job must not overrule
a person's decision.

Nothing else clears the flag. A deferred ticket is not retried when capacity frees up; see
[what is not built](#what-is-not-built).

## The seam, and how TAR-23 and TAR-24 relate

TAR-24 owns rule matching and TAR-23 owns rotation, and neither knows the other's internals.
What joins them is one interface, published by 0007 and adopted by 0008 unchanged:

```ts
resolveFallbackAssignment(
  request: FallbackAssignmentRequest,
): Promise<FallbackAssignmentDecision>;
```

`RuleEngineService` — TAR-24's half — reaches it through the `FALLBACK_ASSIGNMENT_RESOLVER`
injection token, which `AssignmentModule` binds to `RotationFallbackResolver`. The rule engine
calls rotation as its own "no rule matched" branch, and gets back a decision it writes; it
does not know what a cursor is, what a scope is, or how `NULL` team ids key one.

**The seam was drawn before either half was built, and it needed no widening.**
`FallbackAssignmentRequest.teamId` already carried the scope rotation turns its candidate pool
on, and `FALLBACK_ASSIGNMENT_REASONS` already enumerated exactly the three states rotation
distinguishes. That is the confirmation 0007 asked for when it invited a revision.

Three obligations the seam places on any resolver behind that token, worth knowing if you ever
write a second one:

1. **Return a decision; do not write to `tickets`.** The assignment write stays in the engine,
   because it is also the ticket-event append and the one place a supervisor's manual
   assignment must be allowed to win.
2. **Throw for infrastructure failure, never report it as a decision.** "Nobody was eligible"
   is an answer a supervisor acts on; a database fault is a job that should retry.
3. **Name a reason on every `no_eligible_agent`.** The reason is what the supervisor's queue
   renders, and an unexplained flag sends them looking in the wrong place.

⚠️ **One historical note, because the ordering in the issue tracker reads backwards.** TAR-23
was planned as the behaviour TAR-24 would later override, and 0008 anticipated a
`NullFallbackAssignmentResolver` standing in until rotation landed. In the event rotation
landed first, so no stub was ever bound — binding one would have quietly answered "nobody
available" for every unmatched ticket. Both halves are shipped and the seam is load-bearing in
production, not a placeholder.

## Operational limits

### The cap is exact at worker concurrency 1, and only there

The resolver decides and the engine writes, and no lock spans the two. Two routing jobs
running at the same instant can both see an agent at `cap − 1` and both assign, putting that
agent one over.

**The `assignment` worker therefore runs at `concurrency: 1`** — the repo default. Under it
there is no concurrency to lose to and the cap is exact.

Stated so the next person does not have to rediscover it: **raising that concurrency, or
running two API processes, makes the cap approximate.** Overshoot is bounded by the number of
concurrent routing workers minus one, per agent, and self-corrects on the next ticket. If the
cap must stay exact at that point, the fix is a revision to 0007 decision 5 — move the
compare-and-set into the resolver, or have the engine's `UPDATE` carry the cap as an extra
predicate — not a patch to the resolver. An advisory lock inside the resolver was considered
and rejected: it would release at the resolver's commit and leave the write it was meant to
protect outside the critical section, while looking as though the problem were solved.

### Cost, and where it stops scaling

| Query                             | Index used                               | Rows touched                     |
| --------------------------------- | ---------------------------------------- | -------------------------------- |
| Candidate scan                    | `users (tenant_id, status)`              | The tenant's active users — tens |
| Per-candidate active ticket count | `tickets_tenant_assigned_user_queue_idx` | ≤ cap rows per candidate         |
| Cursor read and advance           | `assignment_state_tenant_scope_key`      | 1                                |
| The flagged queue                 | `tickets_routing_deferred_idx`           | The deferred set                 |

**The load count is derived, not denormalised.** A counter column on `users` would make
selection a single scan and is the obvious optimisation. It was rejected for v1 because it
has to be maintained by every path that assigns, unassigns, resolves, closes or reopens a
ticket — and a counter that drifts is a cap that is silently wrong, which is the failure this
whole design exists to make visible. **Breaking point:** tens of thousands of concurrently
active assigned tickets in one tenant; the next step is a trigger-maintained counter, so it
cannot drift.

**No index was added to `users`.** At tens-to-low-hundreds of users per tenant the existing
`(tenant_id, status)` index plus a filter is cheaper than maintaining another index on a table
written on every session touch. **Breaking point:** past roughly a thousand users per tenant;
the additive next step is a partial index on `(tenant_id, availability, last_seen_at)
WHERE status = 'active'`.

### Failure modes

| Component                                   | Behaviour                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `RotationFallbackResolver` throws           | The routing job retries. The ticket stays `pending` and unassigned, and is visible in the unassigned queue                                     |
| `assignment_state` row missing              | Created on the scope's first assignment                                                                                                        |
| `tenant_settings` row missing               | Routing continues on `ASSIGNMENT_POLICY.defaultMaxConcurrentTickets`                                                                           |
| `users.last_seen_at` stops being written    | Every agent ages out and **everything defers with `none_available`**. The loudest failure in this design, deliberately                         |
| A cap lowered below an agent's current load | The agent is skipped until they close down to the new cap. No ticket is taken off them — correct, and worth saying because it looks like a bug |

### What to monitor

- **`routing_state = 'deferred'` count per tenant, and its age.** A product signal rather than
  merely an ops one: a tenant whose deferred count is persistently non-zero is understaffed or
  mis-capped. It complements the _rate_ of `deferred` outcomes — that is a flow, this is the
  standing backlog.
- **Tenant-wide `none_available` against a non-zero live session count.** The specific shape of
  the `last_seen_at` failure above: agents are demonstrably logged in and routing believes
  nobody is there. The presence signal has broken; the office is not empty.

Deliberately not monitored: per-agent assignment counts, which are reporting rather than an
alert, and cursor movement.

## Tenant isolation

Every statement runs on `TenantPrisma`, so `app.tenant_id` is set and row-level security (RLS)
supplies the tenant equality. Nothing in this path uses `SystemPrisma` and nothing needs it.

- **The candidate scan cannot see another tenant.** `users`, `team_members`, `tickets` and
  `tenant_settings` are all RLS-protected, and every predicate also carries `tenant_id`
  explicitly — the rule ADR 0003 states as non-optional, and here also what makes the planner
  use the `(tenant_id, …)` composite indexes.
- **The worker holds no permission of its own.** It is not an HTTP caller; it sets tenant
  context from `job.data.tenantId` before its first statement. A request whose `tenantId` does
  not match the scope the worker opened throws rather than being filtered leniently.
- **No personal information anywhere in this path.** The resolver reads ids, an enum, a
  timestamp and a count. A log line names a user id, a scope and an outcome.

Adding a column to an existing table inherits its RLS policy and grants, so the workload and
routing columns needed no new policy and no re-run of `app-roles.sql`.

## What is not built

Each of these is a deliberate v1 boundary, not an oversight.

- **A deferred ticket is never retried.** It waits for a person even if capacity frees a
  minute later. This matches TAR-23's acceptance criterion exactly. The cheapest additive
  version needs no payload change and no new column — the router re-enqueues its own trigger
  with a delay and stops once `routing_deferred_since` is older than a bound. Build it when a
  supervisor says a minute is too long.
- **Nothing rebalances.** An agent who goes offline holding six tickets keeps them; taking work
  off a person is a supervisor's decision, not a background job's. Visible today through
  `?assignedUserId=`.
- **No skill-, tag- or language-based routing.** Out of scope for TAR-23 explicitly. Team and
  tag matching is a routing rule's job.
- **No cap-editing surface**, as above.
- **No realtime push on a routing change.** `ticket.updated` exists as a server event and
  emits for nothing here; the console refetches the flagged queue. 0008's Realtime section
  specifies the `ticketReadersRoom` fan-out this would need, so the push is additive rather
  than a redesign. Reusing the conversation room would publish ticket bodies to the
  `conversation:read_all` audience, which is an authorization bypass rather than a shortcut.
- **Rotation inside a team a rule targeted.** A matched rule is terminal: a team target sets
  `assigned_team_id` and a member picks the ticket up. Rotation does not then choose a person
  inside that team.

## Verification

Run against `main` at `fd5b412` on 2026-08-15.

- **The selection rule, the eligibility predicates, the reason precedence and the cursor
  write**: `pnpm --filter @whatsappcrm/api exec jest src/assignment src/tickets` — 223 tests,
  all passing, after `pnpm --filter @whatsappcrm/contracts build` and `prisma generate`.
- **Everything above against a real PostgreSQL**, with TAR-48's policies applied and running
  as `whatsappcrm_app` — the role holding no `BYPASSRLS`: `pnpm --filter @whatsappcrm/api
test:db` — 29 suites, 460 tests, all passing. That run covers the rotation order across
  equally-loaded agents, the load-limit skip, load taking precedence over rotation position,
  all three deferral reasons and the cross-tenant candidate scan
  (`rotation-fallback.int-spec.ts`); the flagged queue's order, `deferredReason` and its
  cursor arity (`ticket-flagged-queue.int-spec.ts`); and the CHECK constraint accepting both
  routes out of `deferred` (`ticket-assign.int-spec.ts`).
- **Every constant in [the numbers](#the-numbers)** is quoted from `ASSIGNMENT_POLICY` in
  `packages/contracts/src/assignment.ts`, not transcribed from the design document.
- **The `ORDER BY`, the four predicates and the candidate pool rule** are quoted from the
  statement in `apps/api/src/assignment/rotation-fallback.resolver.ts`.

⚠️ **No deferral was produced by hand**, and the `curl` invocation on this page shows a
request shape rather than a call that was typed at a terminal. Writing the flag needs a
routing job, so a seeded tenant returns an empty flagged page — correctly. Every claim about
what a deferral writes therefore rests on the integration specs above, not on a manual run.
