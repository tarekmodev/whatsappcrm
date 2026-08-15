# Routing rules, evaluation order and the assignment-fallback seam (TAR-279)

Status: proposed · Builds on [0002 — architecture and API contract](./0002-architecture-and-api-contract.md),
[0003 — ticket auto-linking contract](./0003-ticket-auto-linking-contract.md) and
[0004 — RBAC permission matrix](./0004-rbac-permission-matrix.md) · Sibling of
[0006 — SLA timers and supervisor alerts](./0006-sla-timers-and-supervisor-alerts.md),
which shares the business-hours question ·
Consumed by TAR-285 (schema), TAR-288 (backend), TAR-289 (frontend), TAR-290 (QA), TAR-292 (documentation)

## Context and Problem

TAR-24 asks for one thing: a supervisor writes "if the message mentions billing, route it to the
Billing team", and the next matching ticket lands there instead of in the default rotation. Four
facts already on `main` decide most of how that can be built.

1. **The table exists.** TAR-47 shipped `assignment_rules` with `conditions Json`, `action Json`,
   `position`, `is_active` and both target foreign keys, under a comment that reads "TAR-24 owns the
   condition and action grammar". So this is a grammar to fill in and a small delta to apply, not a
   table to design.
2. **Assignment and tickets meet over an event.** `AssignmentModule` is L4 and `TicketsModule` is
   L3 (0002, module boundaries), and 0003 already fixed the emission point — `TicketsModule` emits
   `ticket.created` on the create path only and imports neither `AssignmentModule` nor `SlaModule`.
   0003 deliberately left assignment's side of that boundary undesigned. This document designs it.
3. **TAR-23 is being built at the same time.** Rotation, availability and load limits belong to it.
   TAR-288 has to be buildable and testable before TAR-23 lands, which means the two sides need one
   agreed signature now rather than an integration conversation later.
4. **The permission already exists.** `rbac.ts` carries `assignment_rule:read` and
   `assignment_rule:write`, granted to supervisor and admin, and `apps/web` already gates
   `/settings/assignment` on the read half. TAR-279's issue text proposes `channel:manage`; that is
   the wrong gate and would make routing an admin-only surface. See [security and access](#security-and-access).

The constraint that makes the rest non-trivial is **two stories writing one module in parallel**.
Everything below that looks over-specified — a decision return type instead of a nullable id, a
stub named in the contract, a compare-and-set on a write that "cannot" race — is there because
TAR-288 and TAR-23 cannot see each other's code while they are being written.

### Who confirms the fallback shape

TAR-279's issue text says to confirm the seam "with whoever is driving TAR-23". TAR-271 —
_Assignment service design: round-robin/load-based fallback + rule-engine seam_ — is TAR-23's
design task, and it is assigned to the same architect as this one. The confirmation therefore
resolves here rather than across two documents: **this file is the single definition of the seam,
and TAR-271 adopts it.** If TAR-271 finds the shape cannot carry rotation's real outputs, the fix
is a revision to this file, not a second signature published beside it.

## Goals / Non-Goals

**Goals**

- A condition grammar concrete enough that TAR-289 builds a form against it and TAR-285 validates
  against it, covering exactly the three condition types TAR-24 commits to at launch.
- One evaluation order, with a tie-break that is deterministic rather than incidental.
- A REST surface for rule CRUD following 0002's conventions, adding no error code and no permission.
- A fallback seam narrow enough that TAR-288 builds against a stub, and TAR-23 fills it in without
  TAR-288's code changing.
- The exact delta against TAR-47's `assignment_rules`, specified so TAR-285 writes the migration
  without a second conversation.

**Non-Goals**

- Implementing any of it.
- Rotation, agent availability, per-agent load limits and the supervisor's flagged-ticket view.
  Those are TAR-23, designed in TAR-271. This document defines only the call into them.
- The drag-and-drop rule canvas. TAR-24 puts it out of scope; the surface is a rule list.
- Nested boolean condition trees, and actions other than assignment. That is TAR-27's automation
  engine, and building half of it here would leave two grammars to reconcile later.
- Re-routing a ticket that is already assigned, and re-evaluating rules on every inbound message.
  Routing happens once, when the ticket is created.
- Realtime propagation of rule edits. Rules are a settings surface; a second supervisor sees a
  change on their next load.
- Holiday and exception calendars for business hours. A routing rule asks whether the tenant is open
  right now, which the interval predicate below answers. The calendar is 0006's risk 1 and stays
  open.

---

## Proposed Architecture

```mermaid
sequenceDiagram
  participant TL as TicketLinker<br/>(TAR-75, TicketsModule)
  participant PG as Postgres
  participant Q as BullMQ · queue `assignment`
  participant RE as RuleEngine<br/>(TAR-288, AssignmentModule)
  participant FB as FallbackAssignmentResolver<br/>(TAR-23, same module)

  TL->>PG: INSERT ticket   (outcome: 'created')
  Note over TL,PG: commit
  TL->>Q: assignment.route-ticket { tenantId, ticketId,<br/>contactId, messageId, createdAt }
  Q->>RE: process
  RE->>PG: re-read ticket in tenant scope
  alt ticket already assigned
    RE-->>Q: { outcome: 'skipped', reason: 'already_assigned' }
  else
    RE->>PG: load active rules, ordered (position, id)
    loop first match wins
      RE->>RE: evaluate conditions (AND within a rule)
    end
    alt a rule matched and its target is usable
      RE->>PG: compare-and-set assignment + `assigned` event
      RE-->>Q: { outcome: 'routed', ruleId }
    else no rule matched
      RE->>FB: resolveFallbackAssignment(request)
      alt decision.outcome = 'assigned'
        RE->>PG: compare-and-set assignment + `assigned` event
        RE-->>Q: { outcome: 'fallback_assigned' }
      else decision.outcome = 'no_eligible_agent'
        RE->>PG: `assignment_deferred` event; ticket stays unassigned
        RE-->>Q: { outcome: 'deferred', reason }
      end
    end
  end
```

**The engine and the resolver live in the same module.** 0002's ownership table gives
`AssignmentModule` both "round-robin and the condition-rule engine". So the seam below is an
injected token inside one module, not a layering boundary — it exists for parallel development and
for testability, and this document says so plainly rather than dressing it up as an architectural
necessity.

### Decision 1 — the trigger is a queue job, on the shape 0003 already established

**Trade-off axis: latency of the assignment vs. blast radius of an assignment failure.**

- **Chosen — a BullMQ job on a new `assignment` queue, enqueued by `TicketsModule` after the ticket
  transaction commits.** 0002 routes anything that must survive a restart through BullMQ, and a
  ticket that never gets assigned is a support request nobody is accountable for — the same
  durability class 0003 argued for ticket creation. Reusing that shape means the retry policy, the
  tenant-context propagation into the worker and the payload-in-`packages/contracts` convention all
  come from code that already exists.

  0003's rule 4 already obliges `TicketsModule` to emit `ticket.created` on the create path only.
  This decision fixes the bus and the payload for that emission; it does not add an obligation.

  Cost, stated plainly: assignment is eventually consistent with the ticket. Normally sub-second;
  during a Redis outage, as late as the queue's recovery. The inbox therefore shows an unassigned
  ticket briefly, and any UI that assumes a ticket is born assigned is wrong.

- **Rejected — `@nestjs/event-emitter`.** 0002 reserves the in-process bus for reactions where loss
  is acceptable. An unrouted ticket is not.

- **Rejected — assigning inside the ticket-creation transaction.** Atomic, and it removes the
  eventual-consistency caveat. Rejected on blast radius, for the reason 0003 gives: a bug in
  assignment would roll back the ticket, and a bug in rule evaluation is far more likely than one in
  ticket creation, because tenants author the rules.

**Delivery is at-least-once, and the handler is idempotent by compare-and-set.** The assignment
write is bounded to `assigned_user_id IS NULL AND assigned_team_id IS NULL`, so a redelivered job
finds the ticket assigned and skips. That is the correctness mechanism. `assignmentRouteJobId()`
gives a stable `jobId` so a duplicate enqueue collapses while the first is queued, but it is an
optimisation. The id is hyphen-separated — `assignment-route-<tenantId>-<ticketId>` — because BullMQ
rejects a custom job id containing `:` (0003, rule 5; TAR-249).

**The compare-and-set is also the right product behaviour.** A supervisor who assigns the ticket by
hand in the second before the worker runs keeps their assignment. A blind write would silently undo
a person's decision in favour of a rule.

### Decision 2 — evaluation is `ORDER BY position ASC, id ASC`, first match wins

TAR-24's second acceptance criterion asks for "a defined priority order" and a first match. The
order needs a tie-break, because `assignment_rules.position` is `@default(0)` and carries no unique
constraint: every rule created without an explicit position ties with every other one.

**Trade-off axis: determinism vs. the cost of a reorder.**

- **Chosen — `(position ASC, id ASC)`.** Ids are UUIDv7 (`common.ts`), so `id ASC` is creation order.
  Two rules at the same position therefore evaluate oldest-first, which is both deterministic and
  the answer a supervisor would guess. No extra column, no constraint, and the existing
  `(tenant_id, is_active, position)` index serves it once `id` is appended.

- **Rejected — `UNIQUE (tenant_id, position)`.** The strongest guarantee, and it makes the tie-break
  question disappear. Rejected because every reorder then becomes a multi-row shuffle that
  transiently violates the constraint, which needs `DEFERRABLE INITIALLY DEFERRED` and a
  full-list rewrite inside one transaction. That is real complexity bought to prevent a tie that a
  documented tie-break already answers.

- **Rejected — `(position ASC, created_at ASC, id ASC)`.** `created_at` can tie inside one
  millisecond and `id` already encodes creation order more precisely. A redundant sort column that
  reads as if it were doing something.

**Rules are loaded whole, once per ticket.** The active set is bounded (see
[`ROUTING_RULE_LIMITS`](#limits-and-why-each-one-exists)), so the engine reads
`WHERE is_active = true ORDER BY position, id` in one query and evaluates in memory. No per-rule
query, and no SQL translation of the condition grammar — which also means the grammar can change
without a migration, which is what `conditions JSONB` was for.

**Only active rules are evaluated.** `is_active = false` removes a rule from evaluation and leaves
it in the list, which is what makes it a disable switch rather than a delete.

### Decision 3 — a rule is a flat AND-list of conditions, from a closed set of three types

**Conditions inside one rule combine with AND. Rules combine with OR, by being a list.** That is
the whole boolean model, and it is deliberate: an ordered first-match list already expresses OR, so
adding an `any`/`all` toggle or a nested tree would give two ways to write the same rule and one
more thing for TAR-289's form to render. A supervisor who wants "billing OR invoices" writes one
keyword condition with two values; one who wants two genuinely different shapes writes two rules.

- **Rejected — a nested boolean tree (`{ all: [...], any: [{ not: ... }] }`).** Strictly more
  expressive, and it is what TAR-27's workflow engine will need. Rejected here because TAR-24 ships
  a rule _list_, the three launch condition types compose fine under AND, and a tree the UI cannot
  build is a grammar the API has to keep validating forever.

**Empty `conditions` is refused.** A rule matching everything, placed anywhere but last, silently
swallows all routing, and the thing it would express — "everything else goes here" — is already the
fallback. `validation_failed`, minimum one condition.

#### The three condition types

TAR-24 commits to "keyword/tag match, business hours, contact attribute". Keyword and tag are split
into two types rather than blended into one, because they read different data — the message body
versus the contact's tags — and a single type carrying both would need a mode discriminator anyway.
That is a reading of TAR-24's assumption, not a widening of it: the launch capability is the same
three.

| Type                | Reads                                             | Matches when                                                              |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `keyword`           | `messages.body` of the triggering inbound message | Any / all of `values` appear in the body, case-insensitively              |
| `tag`               | `contact_tags` for the ticket's contact           | Any / all of `tagIds` are on the contact                                  |
| `business_hours`    | `tenant_settings.business_hours` and `.timezone`  | The ticket's `created_at` is inside (`within: true`) or outside the hours |
| `contact_attribute` | `contacts.custom_fields` for the ticket's contact | The named custom field satisfies the operator                             |

**`keyword` matches `messages.body`, which is also the caption on a media message** — so
"if the customer sends a photo captioned 'invoice'" works without a fifth condition type. Matching
is substring, case-insensitive, on the trimmed value; it is not word-boundary aware, so `bill`
matches `billing`. That is the behaviour a non-technical supervisor expects from a box labelled
"contains", and the alternative — regular expressions in a tenant-authored field — is a
denial-of-service surface pointed at our own worker.

**`contact_attribute` reads custom fields only, not built-in contact columns.** The key must name a
row in `custom_field_defs`, which gives the console a dropdown to populate and the API something to
validate against; a free-text attribute path would be a typo that silently never matches. The
built-in columns a rule might plausibly want are already covered — the customer's identity by `tag`,
their words by `keyword`. `custom_fields` values are `string | null` across the wire
(`CustomFieldValuesSchema`), so one string-comparison operator set covers every field type.

**"No contact" and "a contact with nothing set" are different facts.** `contacts.custom_fields`
is a nullable column, and a contact auto-created from a first inbound message leaves it null, so
the engine resolves a null column to `{}` and reserves a null _fact_ for a ticket with no contact
to read. `is_not_set` is therefore **true** of a brand-new contact and **false** on a
contact-less ticket, which is what makes "this field is not set → route to Onboarding" fire for
the population it is written for rather than only for contacts somebody has already edited once.

- **Rejected — a wider `{ source: 'builtin' | 'custom_field', key }` shape.** It is what a
  "contact attribute" reads like in the abstract. Rejected because each built-in it admits needs its
  own comparison semantics (`phone` is E.164, `optedOutAt` is a timestamp, `tags` is a set that
  already has a condition type), and none of them has a caller asking for it. Additive later: a new
  member of the discriminated union, no migration.

**`business_hours` refuses to guess.** When `tenant_settings.business_hours` is `NULL` or has no
open interval for any day, a `business_hours` condition evaluates **false** whichever way `within`
is set, so the rule does not match and evaluation continues. The alternative — treating an
unconfigured tenant as always open, or always closed — makes one of the two natural rules
("out of hours, route to the on-call team") fire on every ticket for a tenant that never configured
anything. Falling through to the next rule, and ultimately to rotation, is the boring failure.
TAR-289 shows the supervisor that the condition needs business hours set.

#### Business hours, formalised

`tenant_settings.business_hours` has had a documented shape since TAR-47 and no interpreter:
`schema.prisma` says "TAR-26 owns its interpretation". This document is its first consumer, so it
publishes the schema and the predicate rather than inventing a private reading of a shared column.

**0006 is why this lands here and not in TAR-26's document.** TAR-269 designed the SLA timers and
put business-hours accounting out of scope: `sla_policies.business_hours_only` "exists and stays
`false`", because turning it on "means a per-tenant holiday calendar and timezone arithmetic", and
it carries that as its own risk 1. The two halves separate cleanly, so this document takes the one
it needs and leaves the other alone:

| Half                                                    | Owner                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Timezone arithmetic — is this instant inside the hours? | Here. `isWithinBusinessHours`, used by `business_hours` conditions |
| A holiday and exception calendar                        | Nobody yet. A non-goal here, risk 1 in 0006                        |

So 0006's risk 1 narrows rather than closes: when someone picks up business-hours SLAs, the
predicate exists and the calendar is what is left to design. Nothing here obliges TAR-26 to turn
`business_hours_only` on, and a routing rule asking about business hours does not start an SLA
timer against them.

```ts
// packages/contracts/src/tenant.ts
export const BUSINESS_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** `HH:MM`, 24-hour, zero-padded. `24:00` is accepted as an end-of-day `to`. */
export const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);

export const BusinessHoursIntervalSchema = z.object({
  from: ClockTimeSchema,
  to: ClockTimeSchema,
});

/** A day absent from the record is closed. `{}` means the tenant is never open. */
export const BusinessHoursSchema = z.record(
  z.enum(BUSINESS_DAYS),
  z.array(BusinessHoursIntervalSchema).max(4),
);

export function isWithinBusinessHours(
  hours: BusinessHours | null,
  timezone: IanaTimezone,
  at: Date,
): boolean;
```

Four semantics that a reader cannot derive from the shape, and that two implementations would
otherwise disagree on:

1. **`from` is inclusive, `to` is exclusive.** `09:00`–`17:00` includes 09:00:00 and excludes
   17:00:00.
2. **An interval whose `to` is less than or equal to its `from` wraps past midnight.**
   `{ from: '22:00', to: '02:00' }` on `fri` covers Friday 22:00 to Saturday 02:00. The day key names
   the day the interval _starts_.
3. **A day key that is absent is closed.** The seeded Northwind tenant lists `mon`–`fri` and no
   weekend, which is what closed looks like. `null` for the whole column means the tenant has not
   configured hours and is handled by the fail-false rule above — it is not the same as `{}`, which
   is a deliberate "never open".
4. **The zone is `tenant_settings.timezone`**, an IANA name validated by `IanaTimezoneSchema`, and
   the comparison is done in that zone. Stored timestamps stay `timestamptz`; nothing here changes
   how a time is stored.

> **TODO(architect):** `isWithinBusinessHours` is specified, not implemented, and no daylight-saving
> edge case has been executed against a real tz database. TAR-288 must cover, as unit tests, an
> interval spanning a spring-forward gap and one spanning an autumn-back repeat in `Europe/London`.
> No behaviour is asserted here for a wall-clock time that does not exist on a given date.

### Decision 4 — a matched rule is terminal

A rule that matches assigns its target and stops. It does not then run rotation to pick a person
inside the targeted team.

**Trade-off axis: a named owner on every ticket vs. doing what the supervisor wrote.**

- **Chosen — terminal.** TAR-24's first acceptance criterion is explicit: a matching ticket "routes
  to that team **instead of** default rotation". A team-routed ticket is visible to that team's
  members under 0004's visibility predicate, and 0002 amendment 6 gives them a claim path for work
  nobody holds. So the ticket is not lost; it is queued for a team, which is what "route to the
  Billing team" means.

- **Rejected — a matched team rule selects the team, then rotation picks an agent within it.**
  Every ticket gets a named owner, which is better for accountability and lets TAR-23's
  all-agents-busy flag fire on rule-routed work too. Rejected because it contradicts TAR-24's
  wording and because it silently couples every rule change to rotation's availability rules — a
  supervisor debugging "why did this go to Sara" would have to understand both systems.

  **It is additive, and the seam is already shaped for it.** `FallbackAssignmentRequest` carries a
  `teamId`, so turning this on later is a call the engine makes after a team match, not a redesign.
  Trigger to revisit: the first supervisor complaint that team-routed tickets sit unclaimed, or
  TAR-30 reporting a time-to-first-response gap between rule-routed and rotation-assigned tickets.

**A user target sets `assigned_user_id` and leaves `assigned_team_id` null; a team target does the
reverse.** Writing both would make "assigned to" ambiguous for every consumer of the visibility
predicate.

#### An unusable target is skipped, not assigned

The engine resolves candidate targets before writing, and treats a rule whose target cannot do the
work as not matching — evaluation continues to the next rule.

| Target state                             | Behaviour                                               |
| ---------------------------------------- | ------------------------------------------------------- |
| User with `status = 'active'`            | Assign                                                  |
| User with `status` `suspended`           | Skip the rule, continue, log a warning with the rule id |
| Team with at least one active member     | Assign                                                  |
| Team with no active members              | Skip the rule, continue, log a warning with the rule id |
| Both targets null (a deactivated orphan) | Not reachable — such a rule is `is_active = false`      |

`status = 'removed'` does not appear because it cannot: `users.service.ts` already clears
`targetUserId` and sets `isActive = false` on every rule targeting a removed user, inside the
removal transaction, under TAR-79's invariant 4. That behaviour is what the `is_active` clause of
the new CHECK constraint below exists to permit — see [data model](#data-model).

- **Rejected — assign anyway and alert.** Cheaper, and 0004 already asks for an alert on records
  assigned to a team with zero members. Rejected because the ticket would be invisible to every role
  without `_all` until someone noticed the alert, whereas skipping puts it in front of rotation
  immediately. The cost is one extra read of the distinct target users and one aggregate over team
  membership per routed ticket, both over sets bounded by the rule cap.

### Decision 5 — the fallback returns a decision and writes nothing

TAR-279's issue text proposes `resolveFallbackAssignment(ticket): AgentId | null`. That signature is
one value short, and the missing value is the one TAR-23's second acceptance criterion is about.

**Trade-off axis: the narrowest possible signature vs. carrying the states the caller must render.**

- **Chosen — a request object in, a decision object out, no side effects.**

  ```ts
  resolveFallbackAssignment(request: FallbackAssignmentRequest): Promise<FallbackAssignmentDecision>
  ```

  Three properties, each load-bearing:

  1. **`no_eligible_agent` is a distinct outcome, not a `null`.** TAR-23 requires that a ticket
     arriving when every agent is offline or at their limit "stays unassigned and is flagged for
     supervisor attention". A bare `null` collapses that operational state — which a supervisor must
     see and can act on by bringing someone online — with "there was nobody to consider", and gives
     the caller nothing to put in the ticket event.
  2. **The resolver decides; the engine writes.** Rotation returns who it picked and does not touch
     the ticket. The assignment write stays in one place, which matters because it is a
     compare-and-set that also appends the ticket event, and because it is the only place tenant
     scope has to be right.
  3. **Infrastructure failure throws; it is never an outcome.** A decision means rotation reached an
     answer. A database error or a missing tenant context propagates, the job fails, and BullMQ's
     retry policy decides what happens next — the same split 0003 makes between a skip and a throw.

- **Rejected — `AgentId | null`, as the issue proposed.** Narrowest, and it is what the caller
  mostly wants. Rejected on point 1: the widening buys the supervisor-visible state that TAR-23 must
  produce, and one shared shape is cheaper than the engine re-deriving "why is this null" from a
  second call.

- **Rejected — the resolver assigns the ticket itself and returns void.** Fewer round trips, and it
  keeps rotation's cursor update in the same transaction as the assignment. Rejected because then
  two services write `tickets.assigned_user_id` on the same code path, and the compare-and-set that
  protects a supervisor's manual assignment would have to be duplicated in both — the class of
  duplication 0004's visibility predicate is written once to avoid.

**TAR-288 builds against a stub, and the stub is named in the contract.**
`NullFallbackAssignmentResolver` returns `{ outcome: 'no_eligible_agent', reason: 'none_available' }`
for every request. It is bound behind `FALLBACK_ASSIGNMENT_RESOLVER` in `AssignmentModule` until
TAR-23's implementation lands, at which point the swap is one provider line. TAR-288's tests use it
directly; nothing in TAR-288 imports rotation.

---

## Data Model

No new table. `assignment_rules` (TAR-47) already carries every field TAR-24 needs, and
`assignment_state` belongs to TAR-23 and is untouched here. Five deltas, all for TAR-285.

| #   | Change                                                                                       | Why                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `name` becomes `@db.Citext`, plus `UNIQUE (tenant_id, name)`                                 | The rule name is what an audit reader sees; two rules named `Billing` and `billing` are indistinguishable in the ticket event log          |
| 2   | `CHECK (NOT is_active OR num_nonnulls(target_user_id, target_team_id) = 1)`                  | An active rule routes to exactly one place. An inactive one may be a target-less orphan, which is a state the shipped code already creates |
| 3   | Drop `action Json`                                                                           | The target is the two foreign-key columns; two representations of one fact is a drift surface with no owner                                |
| 4   | Replace index `(tenant_id, is_active, position)` with `(tenant_id, is_active, position, id)` | The tie-break of decision 2 is part of the sort, so it belongs in the index that serves it                                                 |
| 5   | Nothing for row-level security                                                               | `assignment_rules` already has `ENABLE`/`FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy from the initial migration              |

**Delta 1's citext argument is `teams`', applied to a second name column.** `teams.name` is already
`citext` for exactly this reason, and rules inherit it because decision 6 below puts the rule _name_
into the ticket event that records why a ticket was routed.

**Delta 2 is why the CHECK is conditional.** `users.service.ts` sets
`{ targetUserId: null, isActive: false }` on every rule pointing at a removed user, and its comment
says why: "a supervisor should find the rule needing a new target, not find it silently gone". An
unconditional `num_nonnulls(...) = 1` would make that shipped statement fail at the constraint and
break user removal. The conditional form permits the orphan and still guarantees that anything
evaluated has somewhere to go. The API completes it: a `PATCH` setting `isActive: true` on a rule
with no target is `validation_failed`, so a supervisor is told what is missing rather than shown a
constraint violation.

**Delta 3 needs no data migration.** Nothing in `apps/api`, `apps/web` or `packages/contracts`
reads `assignment_rules.action`; the only references to the model anywhere are the removal cleanup
above and the schema itself. If a later story needs a non-assignment action, it comes back as a
typed column or a fresh JSONB with a published grammar — not as a column that was left lying around
in case.

**Access patterns this adds**

| Query                                                             | Index used                                   | Frequency                                                    |
| ----------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| Load the active rule set, ordered                                 | `(tenant_id, is_active, position, id)`       | Once per ticket created                                      |
| Resolve the distinct target users of the matched candidates       | `users (tenant_id, id)` primary key          | Once per ticket routed                                       |
| "Does this team have an active member" for the matched candidates | `team_members (tenant_id, user_id, team_id)` | Once per ticket routed                                       |
| Tags on the ticket's contact                                      | `contact_tags` primary key                   | Once per ticket, when a `tag` condition exists               |
| Custom fields on the ticket's contact                             | `contacts (tenant_id, id)` primary key       | Once per ticket, when a `contact_attribute` condition exists |
| The triggering message body                                       | `messages (tenant_id, id)` unique            | Once per ticket, when a `keyword` condition exists           |

The contact and message reads are lazy: a tenant whose rules are all `business_hours` pays for
none of them. The reads happen once per ticket, not once per rule.

### Limits, and why each one exists

Published as a constant so the API, the console and this document cannot drift:

```ts
// packages/contracts/src/assignment.ts
export const ROUTING_RULE_LIMITS = {
  /** Active and inactive together. The engine loads the active set whole. */
  rulesPerTenant: 200,
  /** Conditions in one rule, all of which must hold. */
  conditionsPerRule: 10,
  /** Values in one `keyword` condition, and tag ids in one `tag` condition. */
  valuesPerCondition: 25,
  /** Characters in one keyword value. */
  keywordLength: 80,
} as const;
```

None of these is a limit a real tenant meets — a supervisor maintaining 200 ordered rules has
outgrown a rule list and wants TAR-27. They exist because the evaluation cost of one ticket is
`rules × conditions × values` string comparisons on a shared worker, and because the list endpoint
returns the whole set. This is the repo's "bounded payload sizes, never fetch an unbounded set"
rule applied to the one entity here whose size a tenant controls directly.

Exceeding `rulesPerTenant` on create is `conflict`, not `plan_limit_exceeded` — the cap is a
property of the engine, not of the tenant's plan, and answering `402` would send a supervisor to the
billing page to fix something money cannot.

---

## Interfaces

Everything below lands in `packages/contracts/src/assignment.ts`, exported from the package index.
`packages/contracts` is the only thing both sides of every seam here import.

### The queue trigger

```ts
export const ASSIGNMENT_QUEUE = 'assignment';
export const ASSIGNMENT_ROUTE_JOB = 'assignment.route-ticket';

export const TicketRoutingTriggerSchema = z.object({
  tenantId: IdSchema,
  ticketId: IdSchema,
  contactId: IdSchema.nullable(),
  /** The inbound message that caused the ticket. Null for a ticket created by hand (TAR-25). */
  messageId: IdSchema.nullable(),
  createdAt: TimestampSchema,
});

export function assignmentRouteJobId(trigger: TicketRoutingTrigger): string;
```

**Five fields, on 0003's reasoning.** Everything else is reachable from `ticketId`, and the consumer
re-reads all of it in tenant scope regardless, because a queue payload is unauthenticated input.
`messageId` is carried rather than derived so that a `keyword` condition matches the message that
actually opened the ticket, not whichever message is newest by the time the worker runs.

`messageId: null` is the manual-ticket case: `keyword` conditions evaluate false, every other type
still works, and rotation still runs. A `null` `contactId` (TAR-25's contact-less ticket) makes
`tag` and `contact_attribute` evaluate false the same way. **A condition that has no data to read is
false; it never throws and never matches.**

### The rule

```ts
export const ROUTING_CONDITION_TYPES = [
  'keyword',
  'tag',
  'business_hours',
  'contact_attribute',
] as const;

export const KeywordConditionSchema = z.object({
  type: z.literal('keyword'),
  /** `any` — at least one value appears. `all` — every value appears. */
  match: z.enum(['any', 'all']),
  values: z
    .array(z.string().min(1).max(ROUTING_RULE_LIMITS.keywordLength))
    .min(1)
    .max(ROUTING_RULE_LIMITS.valuesPerCondition),
});

export const TagConditionSchema = z.object({
  type: z.literal('tag'),
  match: z.enum(['any', 'all']),
  tagIds: z.array(IdSchema).min(1).max(ROUTING_RULE_LIMITS.valuesPerCondition),
});

export const BusinessHoursConditionSchema = z.object({
  type: z.literal('business_hours'),
  /** `true` — inside the tenant's business hours. `false` — outside them. */
  within: z.boolean(),
});

export const CONTACT_ATTRIBUTE_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'is_set',
  'is_not_set',
] as const;

export const ContactAttributeConditionSchema = z
  .object({
    type: z.literal('contact_attribute'),
    /** Must name a `custom_field_defs.key` in this tenant. */
    key: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_]*$/),
    operator: z.enum(CONTACT_ATTRIBUTE_OPERATORS),
    /** Null exactly when the operator is `is_set` or `is_not_set`. */
    value: z.string().max(200).nullable(),
  })
  .refine((c) => (c.operator === 'is_set' || c.operator === 'is_not_set') === (c.value === null), {
    message: '`value` is required for every operator except `is_set` and `is_not_set`',
  });

export const RoutingConditionSchema = z.discriminatedUnion('type', [
  KeywordConditionSchema,
  TagConditionSchema,
  BusinessHoursConditionSchema,
  ContactAttributeConditionSchema,
]);

/** Exactly one target. Both, or neither, is `validation_failed`. */
export const RoutingTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('team'), teamId: IdSchema }),
  z.object({ kind: z.literal('user'), userId: IdSchema }),
]);

export const AssignmentRuleResponseSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  /** Ascending. Ties break on `id`, which is creation order. */
  position: z.int().min(0),
  isActive: z.boolean(),
  conditions: z.array(RoutingConditionSchema).min(1).max(ROUTING_RULE_LIMITS.conditionsPerRule),
  /**
   * Null only on a rule deactivated by the removal of its target user
   * (`users.service.ts`). A rule cannot be re-enabled until it has one again.
   */
  target: RoutingTargetSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const AssignmentRuleCreateInputSchema = z.object({
  name: z.string().min(1).max(80),
  conditions: z.array(RoutingConditionSchema).min(1).max(ROUTING_RULE_LIMITS.conditionsPerRule),
  target: RoutingTargetSchema,
  /** Omitted, the rule is appended last. */
  position: z.int().min(0).optional(),
  isActive: z.boolean().default(true),
});

export const AssignmentRuleUpdateInputSchema = AssignmentRuleCreateInputSchema.partial();

export const AssignmentRuleReorderInputSchema = z.object({
  /** The tenant's complete rule set, in the order it should evaluate. */
  ruleIds: z.array(IdSchema).max(ROUTING_RULE_LIMITS.rulesPerTenant),
});
```

**`target` is a discriminated union on the wire and two columns in the database.** The union is what
makes "exactly one" unrepresentable-if-wrong for the console and for validation; the columns are
what give the target a foreign key, which JSONB cannot. The mapping is the API's, in one place.

### The fallback seam

```ts
export const FALLBACK_ASSIGNMENT_OUTCOMES = ['assigned', 'no_eligible_agent'] as const;

export const FALLBACK_ASSIGNMENT_REASONS = [
  /** Every candidate is at their configured concurrent-ticket limit. */
  'all_at_capacity',
  /** Every candidate is `away` or `offline`. */
  'none_available',
  /** There was nobody to consider: no team members, or no agents in the tenant. */
  'no_candidate_pool',
] as const;

export const FallbackAssignmentRequestSchema = z.object({
  tenantId: IdSchema,
  ticketId: IdSchema,
  contactId: IdSchema.nullable(),
  /**
   * The team to rotate within, when the caller has one in mind. Null when no
   * rule matched, which is the only case TAR-24 uses today — it is here so that
   * "a team rule selects the team, rotation picks the person" (decision 4's
   * rejected option) needs no signature change.
   */
  teamId: IdSchema.nullable(),
});

export const FallbackAssignmentDecisionSchema = z.object({
  outcome: FallbackAssignmentOutcomeSchema,
  /** Non-null exactly when `outcome` is `assigned`. */
  userId: IdSchema.nullable(),
  /** The team the rotation was taken from, when there was one. */
  teamId: IdSchema.nullable(),
  /** Non-null exactly when `outcome` is `no_eligible_agent`. */
  reason: FallbackAssignmentReasonSchema.nullable(),
});

export interface FallbackAssignmentResolver {
  resolveFallbackAssignment(
    request: FallbackAssignmentRequest,
  ): Promise<FallbackAssignmentDecision>;
}

export const FALLBACK_ASSIGNMENT_RESOLVER: unique symbol;
```

**What TAR-23 owns behind this, and this document does not touch:** who is eligible, what the
concurrent-ticket limit is and where it is configured, how the `assignment_state` cursor advances,
and how the supervisor's flagged-ticket view is built. TAR-271 designs all of it. The only
obligations this seam places on TAR-23 are that it returns a decision rather than writing, that it
throws for infrastructure failure, and that a `no_eligible_agent` decision names a reason.

### The routing result

```ts
export const TICKET_ROUTING_OUTCOMES = [
  'routed',
  'fallback_assigned',
  'deferred',
  'skipped',
] as const;

export const TICKET_ROUTING_SKIP_REASONS = ['already_assigned', 'ticket_not_active'] as const;

export const TicketRoutingResultSchema = z.object({
  outcome: TicketRoutingOutcomeSchema,
  /** The rule that matched. Null on every outcome but `routed`. */
  ruleId: IdSchema.nullable(),
  assignedUserId: IdSchema.nullable(),
  assignedTeamId: IdSchema.nullable(),
  /** A `FallbackAssignmentReason` on `deferred`, a skip reason on `skipped`. */
  reason: z.string().nullable(),
});

export interface TicketRouter {
  routeTicket(trigger: TicketRoutingTrigger): Promise<TicketRoutingResult>;
}

export const TICKET_ROUTER: unique symbol;
```

| Situation                                        | `outcome`           | `ruleId` | `reason`            |
| ------------------------------------------------ | ------------------- | -------- | ------------------- |
| A rule matched and its target was usable         | `routed`            | the rule | `null`              |
| No rule matched; rotation picked someone         | `fallback_assigned` | `null`   | `null`              |
| No rule matched; rotation had nobody             | `deferred`          | `null`   | the fallback reason |
| The ticket was already assigned when the job ran | `skipped`           | `null`   | `already_assigned`  |
| The ticket is `resolved` or `closed`             | `skipped`           | `null`   | `ticket_not_active` |

### The ticket event, and the one contract delta outside this file

Routing writes to `ticket_events` so TAR-32's escalation log and TAR-30's reporting can answer
"why did this ticket go here" without a second table.

| Outcome             | Event type            | `reason`                            | `data`       |
| ------------------- | --------------------- | ----------------------------------- | ------------ |
| `routed`            | `assigned`            | `Routed by rule "Billing keywords"` | `{ ruleId }` |
| `fallback_assigned` | `assigned`            | `Assigned by rotation`              | `{}`         |
| `deferred`          | `assignment_deferred` | the `FallbackAssignmentReason`      | `{}`         |

`actorUserId` is `null` on all three — `ticket_events.actor_user_id` is already documented as null
when the actor is the system.

**`assignment_deferred` is a new entry in `TICKET_EVENT_TYPES`** (`packages/contracts/src/tickets.ts`),
and it is the only change this document makes outside `assignment.ts`. Additive, no migration:
`ticket_events.type` is text precisely so that later stories add types without one. TAR-23 needs the
same event for the ticket that arrives when everyone is busy, so it is declared here once rather
than twice.

**No new error code, and no new permission.** `conflict`, `validation_failed`, `not_found` and
`forbidden` cover every refusal below, and `assignment_rule:read` / `assignment_rule:write` already
exist in `rbac.ts` with the right grants.

### REST surface

An amendment to 0002's endpoint surface, following its conventions unchanged.

```
# Assignment rules                                                        TAR-24
GET    /api/v1/assignment-rules            → AssignmentRuleListResponse   assignment_rule:read
POST   /api/v1/assignment-rules            → AssignmentRuleResponse       assignment_rule:write
                                                                          201
GET    /api/v1/assignment-rules/{id}       → AssignmentRuleResponse       assignment_rule:read
PATCH  /api/v1/assignment-rules/{id}       → AssignmentRuleResponse       assignment_rule:write
DELETE /api/v1/assignment-rules/{id}       → 204                          assignment_rule:write
POST   /api/v1/assignment-rules/reorder    → AssignmentRuleListResponse   assignment_rule:write
```

**The list does not paginate, and that is a deviation with a reason.** 0002 paginates every list,
and `TeamListQuerySchema` states the principle: "few today" is not a property the API can promise a
client. Rules are the case where it can — `rulesPerTenant` is enforced on create, the engine loads
the whole set per ticket anyway, and a cap the server enforces _is_ a promise it can keep. The
response keeps `CursorPage`'s shape with `nextCursor` fixed at `null`, so a generic list client
works against it unchanged and pagination stays addable without a breaking change.

- **Rejected — keyset pagination on `(position, id)` like every other list.** Consistent, and
  nothing else would need explaining. Rejected because `position` is exactly the low-cardinality
  leading column 0002 warns about: rules default to `position = 0`, so a tenant that never reordered
  has its whole set in one tie group, the resume predicate rewinds to the start of it on every page,
  and the form degrades to the scan keyset pagination exists to avoid. Paying that to page a
  200-row bounded set is the wrong trade.

```ts
export const AssignmentRuleListResponseSchema = z.object({
  items: z.array(AssignmentRuleResponseSchema),
  /** Always null. This list is bounded by `ROUTING_RULE_LIMITS.rulesPerTenant`. */
  nextCursor: z.null(),
});
```

#### `POST /api/v1/assignment-rules`

Creates a rule. `position` omitted appends it last — `max(position) + 1` over the tenant's rules,
computed server-side.

**Authentication.** Session cookie, `assignment_rule:write`. Absent, `unauthenticated`; present
without the permission, `forbidden`.

**Idempotency.** No `Idempotency-Key`. 0002 requires one for calls with external side effects —
sends and billing. This writes one row and has none.

| Parameter    | In   | Type    | Required | Default | Notes                                                    |
| ------------ | ---- | ------- | -------- | ------- | -------------------------------------------------------- |
| `name`       | body | string  | yes      | —       | 1–80 characters, unique per tenant, case-insensitively   |
| `conditions` | body | array   | yes      | —       | 1–10 conditions, all of which must hold                  |
| `target`     | body | object  | yes      | —       | `{ kind: 'team', teamId }` or `{ kind: 'user', userId }` |
| `position`   | body | integer | no       | last    | Ascending; ties break on creation order                  |
| `isActive`   | body | boolean | no       | `true`  |                                                          |

```bash
curl -X POST https://acme.app.example.com/api/v1/assignment-rules \
  -H 'Content-Type: application/json' \
  --cookie 'wac_session=…' \
  -d '{
        "name": "Billing keywords",
        "conditions": [
          { "type": "keyword", "match": "any", "values": ["billing", "invoice", "refund"] }
        ],
        "target": { "kind": "team", "teamId": "019fed83-ebd1-774d-86e4-46137546a539" }
      }'
```

```json
{
  "id": "019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa",
  "name": "Billing keywords",
  "position": 3,
  "isActive": true,
  "conditions": [{ "type": "keyword", "match": "any", "values": ["billing", "invoice", "refund"] }],
  "target": { "kind": "team", "teamId": "019fed83-ebd1-774d-86e4-46137546a539" },
  "createdAt": "2026-08-12T09:14:02.118+03:00",
  "updatedAt": "2026-08-12T09:14:02.118+03:00"
}
```

| Status | Code                | Cause                                                                                                                                                                               |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `201`  | —                   |                                                                                                                                                                                     |
| `400`  | `validation_failed` | Grammar, an empty `conditions`, both or neither target, an unknown `custom_field_defs.key`, a `tagIds` entry not in this tenant, a `targetTeamId`/`targetUserId` not in this tenant |
| `401`  | `unauthenticated`   | No session                                                                                                                                                                          |
| `403`  | `forbidden`         | No `assignment_rule:write`                                                                                                                                                          |
| `409`  | `conflict`          | Duplicate `name`, or `rulesPerTenant` already reached                                                                                                                               |

**A target that belongs to another tenant is `validation_failed`, not `not_found`.** Row-level
security means the id is simply not visible, so the server cannot distinguish "another tenant's
team" from "no such team" — and that indistinguishability is the point (0004, security and access).
The refusal names the field, which is what the console needs, and confirms nothing.

#### `PATCH /api/v1/assignment-rules/{id}`

Partial update, same field rules. Two refusals specific to it:

| Status | Code                | Cause                                                                                  |
| ------ | ------------------- | -------------------------------------------------------------------------------------- |
| `400`  | `validation_failed` | `isActive: true` on a rule with no target — name the target, then enable               |
| `404`  | `not_found`         | Unknown id, or another tenant's rule. Never `forbidden`, which would confirm it exists |

`position` in a `PATCH` moves one rule and shifts the rules between its old and new position by
one, inside a single transaction. Moving many at once is `reorder`.

#### `POST /api/v1/assignment-rules/reorder`

Takes the tenant's **complete** rule set in evaluation order and rewrites `position` to the array
index, in one transaction. Returns the reordered list.

**`ruleIds` is the whole set, not a delta**, on `TeamUpdateInputSchema.memberUserIds`' reasoning: a
delta shape reads better in isolation and loses to concurrent edits. Here it also gives optimistic
concurrency for free — if the submitted set is not exactly the tenant's current set, another
supervisor created or deleted a rule since this client loaded the page, and the response is
`conflict` rather than a silent partial reorder.

| Status | Code                | Cause                                                  |
| ------ | ------------------- | ------------------------------------------------------ |
| `200`  | —                   |                                                        |
| `400`  | `validation_failed` | A duplicate id in `ruleIds`                            |
| `409`  | `conflict`          | `ruleIds` is not exactly the tenant's current rule set |

#### `DELETE /api/v1/assignment-rules/{id}`

`204`, and idempotent: deleting an already-deleted rule is `204`, not `404`. Positions of the
remaining rules are left alone — gaps in `position` are harmless, because the order is the sort and
not the values.

Nothing references a rule, so there is nothing to clear first. A ticket routed by a rule keeps the
rule's id and name in its `ticket_events` row, which is a record of what happened and does not
become wrong when the rule is deleted.

### Rules the implementation must follow

1. **Every access through `TenantPrisma`.** `SystemPrisma` has no business here and is not one of
   the five call sites 0002 permits.
2. **`tenant_id` is supplied explicitly on every write.** TAR-49's extension does not inject it;
   RLS's `WITH CHECK` is the backstop, not the mechanism (0003, rule 3).
3. **The worker sets tenant context from `job.data.tenantId` before its first statement**, and
   re-reads every id in the payload rather than trusting it.
4. **The assignment write is a compare-and-set** bounded to `assigned_user_id IS NULL AND
assigned_team_id IS NULL`, in the same transaction as the `ticket_events` append.
5. **`AssignmentModule` imports no L3 module.** It reads tickets, contacts and messages through
   `TenantPrisma` directly, which is a read of the database, not of `TicketsModule`.
6. **Job ids on the `assignment` queue are hyphen-separated.** `:` is rejected by BullMQ at `add()`
   time inside `QueueService.enqueue`, which logs rather than throws — so a violation stops routing
   silently (TAR-249).

---

## Failure Modes and Operations

| Component                        | Down                                                                                    | Slow                                                         | Bad data                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| BullMQ / Redis                   | Tickets are created and stay unassigned. Nothing is lost; the queue drains on recovery. | Tickets appear unassigned for longer.                        | A malformed payload fails schema validation and the job fails loudly rather than misrouting.                                       |
| Rule engine                      | Ticket creation is unaffected — that separation is decision 1.                          | Queue depth grows; the inbound path is untouched.            | A condition with no data to read is false. It never throws and never matches.                                                      |
| `FallbackAssignmentResolver`     | The job throws and retries. The ticket stays unassigned until it succeeds.              | The routing job holds a worker slot for the call's duration. | A decision that violates its own invariants (`assigned` with a null `userId`) fails the response schema in development and test.   |
| `tenant_settings.business_hours` | —                                                                                       | —                                                            | Unparseable JSON makes every `business_hours` condition false and logs once per ticket. The rule falls through; nothing misroutes. |
| A rule targeting an empty team   | —                                                                                       | —                                                            | The rule is skipped and evaluation continues. 0004 already asks for an alert on records assigned to a member-less team.            |

**What to monitor**

- `assignment.route-ticket` jobs in the failed set. A ticket that never got routed is work with no
  owner, which is the same class of silent loss as 0003's unlinked message.
- The rate of `deferred` outcomes. A sustained rise means rotation has nobody, which is the state
  TAR-23 flags for supervisors, and it is worth seeing at the tenant level too.
- Skipped rules — the warning logged when a target is suspended or a team is empty. A rule that is
  skipped every time is a rule its author believes is working.
- Evaluation duration per ticket, against the caps. It is the only part of this design that grows
  with what a tenant writes.

**What is deliberately not monitored:** the routed-versus-fallback ratio, and gaps in `position`.
Both are normal and vary by tenant.

**When routing looks wrong to a supervisor**, the answer is in the ticket's own event log: an
`assigned` event carries the rule name in `reason` and the rule id in `data`, and an
`assignment_deferred` event names why rotation had nobody. That is the first thing to read, before
the rule list.

## Security and Access

Nothing here widens the tenant boundary, and the routing engine holds no permission of its own — it
is not an HTTP caller.

- **`assignment_rule:read` / `assignment_rule:write`, not `channel:manage`.** TAR-279's issue text
  proposes `channel:manage` "or the nearest existing equivalent". The nearer equivalent is exact:
  0004 grants the two `assignment_rule:*` permissions to supervisor and admin under
  "Routing, SLA and automation", `rbac.ts` ships them, and `apps/web`'s `/settings/assignment` page
  already gates on the read half. `channel:manage` is admin-only and holds the Meta credentials;
  routing under it would contradict TAR-22's third acceptance criterion, which puts assignment
  settings in a supervisor's hands.
- **Rules are tenant-scoped like everything else.** `assignment_rules` carries `ENABLE`/`FORCE ROW
LEVEL SECURITY` and a `tenant_isolation` policy from the initial migration, and every path here
  runs through `TenantPrisma`.
- **A rule cannot route to another tenant's team or user.** The target ids are validated in tenant
  scope on write, and the composite foreign keys are `(tenant_id, id)`, so a cross-tenant target
  fails at the constraint even if validation were skipped.
- **`not_found`, never `forbidden`, for a rule the caller cannot see** (0004). Within the tenant,
  rules are not subject to the visibility predicate — they are tenant configuration, not assignable
  records, and everyone holding `assignment_rule:read` sees all of them.
- **No PII in the job payload or in log lines.** The trigger carries ids and a timestamp. Keyword
  matching reads a message body in memory and never logs it — a rule-evaluation log line names the
  rule and the outcome, never the text that matched.
- **Rule writes are audited.** `audit_logs` rows for `assignment_rule.created`, `.updated`,
  `.deleted` and `.reordered`, with the rule name and the target in metadata. A rule is a standing
  instruction about where customer conversations go, which is the same class of change as a team
  membership edit — and 0004 audits those.

## Implementation Phases

Already broken out as sub-issues of TAR-24; this maps the contract onto them.

| Phase   | Delivers from this document                                                                                               | Blocked by       |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| TAR-279 | This document; `assignment.ts`; `BusinessHoursSchema` in `tenant.ts`; `assignment_deferred` in `TICKET_EVENT_TYPES`       | — (this issue)   |
| TAR-285 | The five schema deltas, as one reversible migration, plus the `verify-tenant-isolation` run that proves nothing regressed | TAR-279          |
| TAR-288 | `RuleEngine`, the CRUD controller, `NullFallbackAssignmentResolver`, and the `TicketsModule` enqueue                      | TAR-279, TAR-285 |
| TAR-289 | The rule list and condition form, against the mock transport until TAR-288 ships                                          | TAR-279          |
| TAR-290 | The test plan from TAR-24's acceptance criteria, executed against the integrated result                                   | TAR-288, TAR-289 |
| TAR-292 | `docs/reference/` entries for the endpoints and the rule entity; the changelog line                                       | TAR-291          |

**TAR-288's enqueue is a change inside `TicketsModule`, and it is the one place these two stories
touch.** `TicketLinker`'s `created` path gains an enqueue onto the `assignment` queue after commit,
exactly as the inbound processor enqueues `ticket.ensure-for-message`. It is named here so it is
reviewed as part of TAR-24 rather than discovered during integration.

**`QueueModule` is TAR-41's and does not block TAR-285 or TAR-289.** The engine takes a plain
payload object, so a fixture is a literal and its unit tests need no queue — the same property
0003 relied on for TAR-75.

## Open Questions and Risks

| #   | Item                                                                                                                                                             | Severity | Resolution                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **A matched team rule leaves the ticket unowned** (decision 4). Team-routed work depends on a member claiming it, and TAR-23's all-busy flag never fires for it. | Medium   | Following TAR-24's wording. `FallbackAssignmentRequest.teamId` already carries the hint, so rotating within a matched team is a call, not a redesign. Revisit on the first unclaimed-queue complaint. |
| 2   | **Routing is evaluated once, at ticket creation.** A customer whose second message says "billing" does not re-route, because the rule ran against the first.     | Medium   | Deliberate: re-routing a ticket someone is already working is worse than not routing it. TAR-290 should confirm it matches what TAR-24's author expects before TAR-288 ships.                         |
| 3   | **`isWithinBusinessHours` has no daylight-saving behaviour asserted.** Spring-forward removes an hour that a `from` may name.                                    | Medium   | TAR-288 covers both transitions as unit tests in `Europe/London`. No behaviour is claimed here.                                                                                                       |
| 4   | **Substring keyword matching has no word boundary**, so `bill` matches `billing` and, less happily, `billboard`.                                                 | Low      | Accepted at v1 — it is what "contains" means to the person writing the rule. A `wholeWord: boolean` is additive on `KeywordConditionSchema`.                                                          |
| 5   | **Evaluation cost is `rules × conditions × values` per ticket** on a shared worker, and no benchmark is claimed.                                                 | Low      | Bounded by `ROUTING_RULE_LIMITS`. Measure in TAR-290 at the cap. The next step is a per-tenant compiled-rule cache keyed on the tenant's newest `updated_at`, which is additive.                      |
| 6   | **`contact_attribute` reads custom fields only.** A tenant wanting to route on the contact's email domain cannot.                                                | Low      | No caller has asked. Additive as a new member of the condition union, with no migration.                                                                                                              |
| 7   | **Dropping `assignment_rules.action` forecloses a non-assignment rule action** — "set priority to urgent", say.                                                  | Low      | That is TAR-27's automation engine, which owns trigger/condition/action properly. If TAR-24 needs it first, it returns as a typed column with a published grammar.                                    |
