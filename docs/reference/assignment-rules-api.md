# Assignment rules API reference

The six routes behind routing rules — `/api/v1/assignment-rules` — and the evaluation
engine that reads what they write. Written for engineers building against the API or the
console.

A **routing rule** is a standing instruction from a supervisor: _when a new ticket looks
like this, send it there_. Rules are tenant configuration, not assignable records. They are
evaluated once, when a ticket is created, in an order the tenant controls; the first rule
that matches wins, and a ticket no rule claimed falls through to rotation.

Request and response shapes are defined in `packages/contracts/src/assignment.ts` and
validated at the boundary. Enforcement lives in `apps/api/src/assignment/`. The design and
its trade-offs are
[0007 — routing rules and the assignment-fallback seam](../architecture/0007-routing-rules-and-assignment-fallback.md);
what sits behind the fallback is
[0008 — assignment rotation and workload](../architecture/0008-assignment-rotation-and-workload.md).
Where this page and 0007 disagree, this page describes what shipped — the two known
differences are called out under [Deviations from 0007](#deviations-from-0007).

For supervisors writing rules in the console rather than calling the API, read
[Route new tickets to the right team](../guides/route-new-tickets-with-rules.md).

## Conventions

| Concern           | Rule                                                                              |
| ----------------- | --------------------------------------------------------------------------------- |
| Base path         | `/api/v1`                                                                         |
| Tenant            | Resolved from the request `Host`, never from a body, header or query parameter    |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                   |
| Lists             | `{ items, nextCursor }`. **This list does not paginate** — `nextCursor` is `null` |
| Timestamps        | ISO 8601 with an explicit offset                                                  |
| Error shape       | The standard envelope, with a code from `packages/contracts/src/error-codes.ts`   |
| `Idempotency-Key` | Not used here. Nothing on this surface has an external side effect                |

**The list is the one deviation from 0002's pagination rule, and it has a reason.**
`rulesPerTenant` is enforced on create, and the engine loads the whole active set per
ticket anyway, so a bounded response is a promise the server can keep. The `CursorPage`
shape is retained with `nextCursor` fixed at `null`, so a generic list client works against
it unchanged and pagination stays addable without a breaking change.

## Authentication

Every route requires a signed-in user presenting the session cookie `wac_session` —
`__Host-wac_session` wherever `SESSION_COOKIE_SECURE` is on. Three global guards run before
any handler: **where** the request is (`HostTenantGuard`), **who** is making it
(`PrincipalGuard`), then **may they** (`PermissionGuard`).

| Condition                                        | Answer                |
| ------------------------------------------------ | --------------------- |
| No cookie, or an expired, revoked or unknown one | `401 unauthenticated` |
| A valid session belonging to a different tenant  | `401 tenant_mismatch` |
| Signed in, but the role lacks the permission     | `403 forbidden`       |
| The rule is in another tenant                    | `404 not_found`       |

## Permissions

| Route                                   | Permission              | Held by           |
| --------------------------------------- | ----------------------- | ----------------- |
| `GET /api/v1/assignment-rules`          | `assignment_rule:read`  | supervisor, admin |
| `GET /api/v1/assignment-rules/{id}`     | `assignment_rule:read`  | supervisor, admin |
| `POST /api/v1/assignment-rules`         | `assignment_rule:write` | supervisor, admin |
| `PATCH /api/v1/assignment-rules/{id}`   | `assignment_rule:write` | supervisor, admin |
| `DELETE /api/v1/assignment-rules/{id}`  | `assignment_rule:write` | supervisor, admin |
| `POST /api/v1/assignment-rules/reorder` | `assignment_rule:write` | supervisor, admin |

**Not `channel:manage`.** That permission is admin-only and holds the Meta credentials;
gating routing behind it would take assignment settings out of a supervisor's hands. The
matrix is [ADR 0004](../architecture/0004-rbac-permission-matrix.md).

**Rules are not subject to the ticket visibility predicate.** They are tenant
configuration, so every principal holding `assignment_rule:read` sees all of them. A rule
the caller cannot see answers `not_found`, never `forbidden`, which would confirm the id
exists somewhere.

## The rule

```json
{
  "id": "019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa",
  "name": "Billing keywords",
  "position": 3,
  "isActive": true,
  "conditions": [{ "type": "keyword", "match": "any", "values": ["invoice", "billing"] }],
  "target": { "kind": "team", "teamId": "019fed83-ebd1-774d-86e4-46137546a539" },
  "createdAt": "2026-08-12T09:14:02.118+03:00",
  "updatedAt": "2026-08-12T09:14:02.118+03:00"
}
```

| Field        | Type             | Notes                                                                                       |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------- |
| `name`       | string, 1–80     | Unique per tenant, **case-insensitively** — the column is `citext`                          |
| `position`   | integer ≥ 0      | Ascending evaluation order. Ties break on `id`, which is creation order                     |
| `isActive`   | boolean          | `false` removes the rule from evaluation and leaves it in the list                          |
| `conditions` | array, 1–10      | All must hold. See [the condition grammar](#the-condition-grammar)                          |
| `target`     | object or `null` | `{ kind: 'team', teamId }` or `{ kind: 'user', userId }`. Null only on a deactivated orphan |

**`target` is null only on a rule whose target user was removed.** `UsersService` clears
`targetUserId` and sets `isActive = false` inside the removal transaction, deliberately, so
a supervisor finds a rule needing a new target rather than finding it silently gone. Such a
rule cannot be re-enabled until it has one again.

### Limits

Published as `ROUTING_RULE_LIMITS` in `packages/contracts/src/assignment.ts`, so the API,
the console and the design document cannot drift.

| Limit                | Value | Covers                                                  |
| -------------------- | ----- | ------------------------------------------------------- |
| `rulesPerTenant`     | 200   | Active and inactive together                            |
| `conditionsPerRule`  | 10    | Conditions in one rule                                  |
| `valuesPerCondition` | 25    | Values in one `keyword` condition, tag ids in one `tag` |
| `keywordLength`      | 80    | Characters in one keyword value                         |

None is a limit a real tenant meets. They exist because evaluating one ticket costs
`rules × conditions × values` string comparisons on a shared worker, and because the list
endpoint returns the whole set.

### The condition grammar

**Conditions inside one rule combine with AND. Rules combine with OR, by being an ordered
list.** That is the whole boolean model: there is no rule-level `any`/`all` toggle and no
nested tree. A supervisor who wants "billing OR invoices" writes one keyword condition with
two values; one who wants two genuinely different shapes writes two rules.

An empty `conditions` array is refused. A rule matching everything, placed anywhere but
last, would swallow all routing — and the thing it would express is already the fallback.

| Type                | Reads                                                 | Matches when                                                       |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `keyword`           | `messages.body` of the message that opened the ticket | Any / all of `values` appear in the body                           |
| `tag`               | `contact_tags` for the ticket's contact               | Any / all of `tagIds` are on the contact                           |
| `business_hours`    | `tenant_settings.business_hours` and `.timezone`      | The ticket's `created_at` is inside (`within: true`) or outside it |
| `contact_attribute` | `contacts.custom_fields` for the ticket's contact     | The named custom field satisfies the operator                      |

```json
[
  { "type": "keyword", "match": "any", "values": ["invoice", "billing"] },
  { "type": "tag", "match": "all", "tagIds": ["019fed85-1a20-7c31-9b04-8f2ad51c7e10"] },
  { "type": "business_hours", "within": false },
  { "type": "contact_attribute", "key": "plan_tier", "operator": "equals", "value": "gold" }
]
```

**`keyword` matching is substring, case-insensitive, on the trimmed value.** It is not
word-boundary aware, so `bill` matches `billing` and also `billboard`. That is what
"contains" means to the person writing the rule, and the alternative — tenant-authored
regular expressions — is a denial-of-service surface pointed at our own worker. A value
that is nothing but whitespace never matches, which stops one blank box in the console from
turning a rule into "match everything". The body of a media message is its caption, so a
photo captioned "invoice" routes without a fifth condition type.

**`contact_attribute` reads custom fields only, never a built-in contact column.** `key`
must name a row in `custom_field_defs`; a key that names no definition is refused on write,
because a typo that silently never matches is the hardest kind of routing bug to see.

| Operator     | `value`  | True when                                                       |
| ------------ | -------- | --------------------------------------------------------------- |
| `equals`     | required | The field is present and equal, case-sensitively                |
| `not_equals` | required | The field is **present** and different                          |
| `contains`   | required | The field is present and contains the value, case-insensitively |
| `is_set`     | `null`   | The field is present and not null                               |
| `is_not_set` | `null`   | The field is absent, or present and null                        |

`value` is required for every operator except `is_set` and `is_not_set`, where it must be
`null`. The three comparison operators are all false against an absent field, `not_equals`
included — that keeps `is_not_set` the single way to write "this field is empty".

**`business_hours` refuses to guess.** When the tenant has no configured hours, the stored
value does not parse, or the configured hours contain no open interval at all, the
condition is **false whichever way `within` is set** — the rule does not match and
evaluation continues. Treating an unconfigured tenant as always open, or always closed,
would make "out of hours, route to the on-call team" fire on every ticket for a tenant that
never configured anything.

`business_hours` semantics, from `isWithinBusinessHours` in
`packages/contracts/src/tenant.ts`: `from` is inclusive and `to` is exclusive; an interval
whose `to` is at or before its `from` wraps past midnight, and the day key names the day it
_starts_; a day key that is absent is closed; the comparison is done in
`tenant_settings.timezone`.

## `GET /api/v1/assignment-rules`

The tenant's whole rule set, in evaluation order — `position` ascending, ties broken on
`id`. Active and inactive rules together. Takes no parameters.

```bash
curl -b cookies.txt https://acme.app.example.com/api/v1/assignment-rules
```

```json
{
  "items": [
    {
      "id": "019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa",
      "name": "Billing keywords",
      "position": 0,
      "isActive": true,
      "conditions": [{ "type": "keyword", "match": "any", "values": ["invoice", "billing"] }],
      "target": { "kind": "team", "teamId": "019fed83-ebd1-774d-86e4-46137546a539" },
      "createdAt": "2026-08-12T09:14:02.118+03:00",
      "updatedAt": "2026-08-12T09:14:02.118+03:00"
    }
  ],
  "nextCursor": null
}
```

| Status | Code              | Cause                     |
| ------ | ----------------- | ------------------------- |
| `200`  | —                 |                           |
| `401`  | `unauthenticated` | No session                |
| `403`  | `forbidden`       | No `assignment_rule:read` |

The order this returns is the order the engine evaluates in, out of the same index. A list
that showed a different order from the one that routes would be worse than no list.

## `POST /api/v1/assignment-rules`

Creates a rule.

**Idempotency.** No `Idempotency-Key`. 0002 requires one for calls with external side
effects — sends and billing. This writes one row and has none. Replaying the call creates a
second rule, or answers `409 conflict` on the duplicate name.

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
  -b cookies.txt \
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

| Status | Code                | Cause                                                                                                                                |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `201`  | —                   |                                                                                                                                      |
| `400`  | `validation_failed` | Grammar, an empty `conditions`, both or neither target, an unknown `custom_field_defs.key`, a target team or user not in this tenant |
| `401`  | `unauthenticated`   | No session                                                                                                                           |
| `403`  | `forbidden`         | No `assignment_rule:write`                                                                                                           |
| `409`  | `conflict`          | Duplicate `name`, or `rulesPerTenant` already reached                                                                                |

`validation_failed` carries `details` naming the field: `target.teamId`, `target.userId` or
`conditions.key`.

**A target belonging to another tenant is `validation_failed`, not `not_found`.**
Row-level security means the id is simply not visible, so the server cannot distinguish
"another tenant's team" from "no such team" — and that indistinguishability is the point.
The refusal names the field, which is what the console needs, and confirms nothing.

**`position` omitted appends the rule last** — `max(position) + 1` over the tenant's rules,
computed server-side, or `0` for the first rule. **A `position` supplied explicitly is
written as given and shifts nothing**, so it can tie with an existing rule; the tie breaks
on `id`, which means the new rule evaluates after the existing one. Use `reorder` to place
a rule between two others.

**The rule cap is checked, then the row is written**, so two creates racing at the boundary
can both pass and leave the tenant one rule over 200. That is accepted rather than locked:
the consequence is a 201st rule on a bound that exists to keep per-ticket evaluation cheap,
not a correctness failure.

## `GET /api/v1/assignment-rules/{id}`

One rule.

| Status | Code                | Cause                                |
| ------ | ------------------- | ------------------------------------ |
| `200`  | —                   |                                      |
| `400`  | `validation_failed` | `{id}` is not a UUID                 |
| `401`  | `unauthenticated`   | No session                           |
| `403`  | `forbidden`         | No `assignment_rule:read`            |
| `404`  | `not_found`         | Unknown id, or another tenant's rule |

## `PATCH /api/v1/assignment-rules/{id}`

Partial update. Every field of the create body is optional and follows the same rules.

```bash
curl -X PATCH https://acme.app.example.com/api/v1/assignment-rules/019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"isActive": false}'
```

| Status | Code                | Cause                                                                                  |
| ------ | ------------------- | -------------------------------------------------------------------------------------- |
| `200`  | —                   |                                                                                        |
| `400`  | `validation_failed` | Grammar, an unknown reference, or `isActive: true` on a rule with no target            |
| `401`  | `unauthenticated`   | No session                                                                             |
| `403`  | `forbidden`         | No `assignment_rule:write`                                                             |
| `404`  | `not_found`         | Unknown id, or another tenant's rule. Never `forbidden`, which would confirm it exists |
| `409`  | `conflict`          | Duplicate `name`                                                                       |

**The target and the active flag are checked against the rule as it will be _after_ the
patch.** Enabling a rule and naming its target in one call is allowed; enabling one without
a target is `validation_failed` on the path `target`, so the supervisor is told what is
missing rather than shown a constraint violation.

**`position` here moves one rule and shifts the rules it passes by one**, inside a single
transaction. Moving down the list, everything stepped over moves up one; moving up,
everything moves down one. Moving many at once is `reorder`.

## `DELETE /api/v1/assignment-rules/{id}`

`204`, and **idempotent**: deleting an already-deleted rule is `204`, not `404`.

| Status | Code                | Cause                      |
| ------ | ------------------- | -------------------------- |
| `204`  | —                   |                            |
| `400`  | `validation_failed` | `{id}` is not a UUID       |
| `401`  | `unauthenticated`   | No session                 |
| `403`  | `forbidden`         | No `assignment_rule:write` |

Positions of the remaining rules are left alone. Gaps in `position` are harmless, because
the order is the sort and not the values, and closing them would rewrite every row after
the deleted one for no behaviour change.

Nothing references a rule, so there is nothing to clear first. A ticket routed by a rule
keeps the rule's id and name in its `ticket_events` row — a record of what happened, which
does not become wrong when the rule goes.

## `POST /api/v1/assignment-rules/reorder`

Takes the tenant's **complete** rule set in evaluation order and rewrites `position` to the
array index, in one transaction. Returns the reordered list in the list endpoint's shape.

| Parameter | In   | Type  | Required | Default | Notes                                        |
| --------- | ---- | ----- | -------- | ------- | -------------------------------------------- |
| `ruleIds` | body | array | yes      | —       | Every rule the tenant holds, at most 200 ids |

```bash
curl -X POST https://acme.app.example.com/api/v1/assignment-rules/reorder \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{
        "ruleIds": [
          "019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa",
          "019fee02-88b4-7d15-a0c9-71e3f4b28d55"
        ]
      }'
```

| Status | Code                | Cause                                                                    |
| ------ | ------------------- | ------------------------------------------------------------------------ |
| `200`  | —                   |                                                                          |
| `400`  | `validation_failed` | An id that is not a UUID, or more than 200 ids                           |
| `401`  | `unauthenticated`   | No session                                                               |
| `403`  | `forbidden`         | No `assignment_rule:write`                                               |
| `409`  | `conflict`          | `ruleIds` is not exactly the tenant's current rule set, or repeats an id |

**`ruleIds` is the whole set, not a delta**, and that buys optimistic concurrency for free:
a submitted set that is not exactly the tenant's current set means another supervisor
created or deleted a rule since this client loaded the page, and the answer is `conflict`
rather than a silent partial reorder. A set that repeats one id and omits another has the
right length and the wrong contents, and is refused the same way.

## Auditing

Every write records an `audit_logs` row: `assignment_rule.created`, `.updated`, `.deleted`
and `.reordered`, with `target_type = 'assignment_rule'`. A rule is a standing instruction
about where customer conversations go — the same class of change as a team membership edit,
which 0004 already audits.

**Metadata carries the rule's name, `isActive` and target, never its conditions.** A
`contact_attribute` value is tenant data and can carry personal information, and the audit
table is exported for compliance review rather than being a place to discover it.

A reorder names the rule that now evaluates first as its `target_id`, because
`audit_logs.target_id` is not nullable and that is the fact an auditor reading "somebody
reordered routing" wants next. A reorder of an empty set uses the all-zero UUID.

## How a ticket is routed

Rules are not applied by the CRUD surface. `TicketsModule` enqueues
`assignment.route-ticket` on the `assignment` BullMQ queue after a ticket-creating
transaction commits, and `AssignmentQueueRunner` drives `RuleEngineService` from it.

**Routing is evaluated once, at ticket creation, against the message that opened the
ticket.** Later messages on the same ticket do not re-evaluate anything: re-routing a
ticket an agent is already working is worse than not routing it.

**Assignment is therefore eventually consistent with the ticket.** Normally sub-second;
during a Redis outage, as late as the queue's recovery. Any UI assuming a ticket is born
assigned is wrong. If `REDIS_URL` is unset no worker starts, tickets are still created, and
nothing is routed by rule or by rotation — the API logs that once, loudly, at boot.

The sequence, per ticket:

1. **Re-read the ticket in tenant scope.** The trigger is a queue payload — unauthenticated
   input — so every id in it is re-read rather than trusted. A ticket that is not visible
   throws and the job retries; the realistic cause is the job overtaking the transaction
   that created its ticket.
2. **Skip if there is nothing to do.** A `resolved` or `closed` ticket is
   `skipped / ticket_not_active`; one that already has an assignee or a team is
   `skipped / already_assigned`.
3. **Load the active rules**, `WHERE is_active = true ORDER BY position, id`, in one query.
   A rule whose stored conditions no longer parse is dropped with a warning rather than
   failing the job.
4. **Read only the facts the rules need**, once per ticket. A tenant whose rules are all
   `business_hours` touches neither the contact nor the message.
5. **Evaluate in order, first match wins.** A rule whose target cannot take work — a
   suspended user, or a team with no active members — is treated as **not matching**, a
   warning is logged with the rule id, and evaluation continues to the next rule.
6. **A matched rule is terminal.** It assigns its target and stops; it does not then run
   rotation to pick a person inside a targeted team. A user target sets `assigned_user_id`
   and leaves `assigned_team_id` null; a team target does the reverse.
7. **No match calls rotation** — `resolveFallbackAssignment`, implemented by
   `RotationFallbackResolver` (TAR-23). The resolver decides and writes nothing; the
   assignment write stays in the engine.

**Bad tenant data never throws.** A rule whose conditions do not parse, a business-hours
column holding something unexpected, a contact with no tags: each makes a condition false,
the rule falls through, and evaluation continues. The failure mode of a routing engine has
to be "this ticket went to rotation", never "this ticket went to the wrong team" and never
"the queue stopped". Infrastructure failure is the opposite and propagates, so BullMQ's
retry policy decides what happens next.

**The write is a compare-and-set** bounded to `assigned_user_id IS NULL AND assigned_team_id
IS NULL`, in the same transaction as the `ticket_events` append. That is what makes
at-least-once delivery safe, and it is also the right product behaviour: a supervisor who
assigns the ticket by hand in the second before the worker runs keeps their assignment.

### Outcomes

`TicketRoutingResult`, returned by `routeTicket` and logged by the runner.

| Situation                                        | `outcome`           | `ruleId` | `reason`            |
| ------------------------------------------------ | ------------------- | -------- | ------------------- |
| A rule matched and its target was usable         | `routed`            | the rule | `null`              |
| No rule matched; rotation picked someone         | `fallback_assigned` | `null`   | `null`              |
| No rule matched; rotation had nobody             | `deferred`          | `null`   | the fallback reason |
| The ticket was already assigned when the job ran | `skipped`           | `null`   | `already_assigned`  |
| The ticket is `resolved` or `closed`             | `skipped`           | `null`   | `ticket_not_active` |

`deferred` carries a `FallbackAssignmentReason`: `all_at_capacity` (every candidate is at
their concurrent-ticket limit), `none_available` (every candidate is away, offline or not
seen recently), or `no_candidate_pool` (there was nobody to consider). The ticket stays
unassigned and is flagged for supervisor attention.

### The ticket event

Routing writes to `ticket_events`, so "why did this ticket go here" is answerable from the
ticket itself.

| Outcome             | Event type            | `reason`                            | Also carries |
| ------------------- | --------------------- | ----------------------------------- | ------------ |
| `routed`            | `assigned`            | `Routed by rule "Billing keywords"` | `ruleId`     |
| `fallback_assigned` | `assigned`            | `Assigned by rotation`              | —            |
| `deferred`          | `assignment_deferred` | the fallback reason                 | —            |

`actor_user_id` is null on all three: `ticket_events` already documents null as "the actor
is the system". The rule **name** is in the event and the rule **id** beside it, so the
answer survives both a rename and a delete.

## Security and isolation

- Every path runs through `TenantPrisma`. `assignment_rules` carries
  `ENABLE`/`FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy from the initial
  migration.
- A rule cannot route to another tenant's team or user. Target ids are validated in tenant
  scope on write, and the composite foreign keys are `(tenant_id, id)`, so a cross-tenant
  target fails at the constraint even if validation were skipped.
- The routing engine holds no permission of its own — it is not an HTTP caller. The worker
  sets tenant context from `job.data.tenantId` before its first statement.
- **No personal information in the job payload or in log lines.** The trigger carries ids
  and a timestamp. Keyword matching reads a message body in memory and never logs it: a
  rule-evaluation log line names the rule and the outcome, never the text that matched.

## What to monitor

- `assignment.route-ticket` jobs in the failed set. A ticket that never got routed is work
  with no owner.
- The rate of `deferred` outcomes. A sustained rise means rotation has nobody.
- Skipped rules — the warning logged when a matched rule's target is suspended or its team
  is empty. **A rule that is skipped every time is a rule its author believes is working.**
- Evaluation duration per ticket, against the caps. It is the only part of this design that
  grows with what a tenant writes.

Deliberately not monitored: the routed-versus-fallback ratio, and gaps in `position`. Both
are normal and vary by tenant.

## Known gaps

Open at the time of writing, all filed:

- **`is_not_set` does not match a contact that has never had a custom field written**
  (TAR-370). `readCustomFields` returns "unanswerable" both when the ticket has no contact
  and when the contact exists with a null `custom_fields` column, and every operator is
  false against unanswerable. Contacts auto-created from a first inbound message have a
  null column, so a rule like "`plan_tier` is not set → Onboarding team" does not fire for
  a brand-new customer. It behaves correctly for any contact somebody has edited once.
- **`tag` condition ids are not validated against the tenant on write** (TAR-370). A rule
  referencing a since-deleted tag id is accepted, and then never fires. The console's mock
  transport refuses the same body, so the two disagree.
- **Selecting more than 25 tags in the console** produces a generic submit error rather
  than a field-level message (TAR-371). The API refuses it correctly either way.
- **No daylight-saving behaviour is asserted for `isWithinBusinessHours`** beyond its unit
  tests. 0007 carries this as risk 3.

## Deviations from 0007

Two, both where the shipped behaviour is the better one:

1. **A duplicate id in `reorder` answers `409 conflict`, not `400 validation_failed`.** The
   check is "is this exactly the current set", and a repeated id fails it for the same
   reason a missing one does. 0007's table predates the implementation.
2. **No `NullFallbackAssignmentResolver` is bound.** 0007 anticipated a stub until rotation
   landed; rotation landed first, so `FALLBACK_ASSIGNMENT_RESOLVER` is bound to the real
   `RotationFallbackResolver`. Binding a stub would quietly answer "nobody available" for
   every unmatched ticket.

> **TODO(author):** 0007 is still marked `Status: proposed` in its header, though every
> phase it plans has shipped and merged. Whoever owns that document should move it to
> accepted, or say what is still open.

## Verification

Everything below was run on 2026-08-15, against `main` at the commit this page was written
from.

- **The condition grammar, evaluation order, target-usability skipping and fallback
  dispatch**: `pnpm --filter @whatsappcrm/api exec jest src/assignment` — 84 tests, all
  passing.
- **Every status code, error code and isolation claim on this page**:
  `apps/api/src/assignment/routing-rules.int-spec.ts`, run against a real PostgreSQL and
  the real request pipeline over two tenants with deliberately identical fixtures — 34
  tests, all passing.
- **Every JSON body on this page** parses against its schema in
  `packages/contracts/src/assignment.ts`.

The `curl` invocations show the request shape against a deployed host. They were not
themselves typed at a terminal: the calls that were run are the integration spec's, issued
through `supertest` against its own two fixture hosts, and that is where every status code
above comes from.
