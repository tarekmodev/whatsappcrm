# Workflow automation API reference

The nine routes behind workflow automation — `/api/v1/workflows` and
`/api/v1/workflow-catalog` — and the engine that runs what they write. Written for
engineers building against the API or the console.

A **workflow** is one rule a supervisor writes: **one trigger, one condition set, one
ordered action list**. When the trigger's occurrence happens on a ticket and every condition
holds, the actions run against that ticket without anybody watching. Workflows are tenant
configuration, not assignable records.

**Every matching workflow runs.** That is the difference from a routing rule, where the
first match wins and the rest are never considered, and it is the reason this surface's
vocabulary is deliberately not that one's. `position` here is _execution_ order, not
selection order.

Request and response shapes are defined in `packages/contracts/src/workflows.ts` and
validated at the boundary. Enforcement lives in `apps/api/src/workflows/`. The design and
its trade-offs are
[0009 — workflow automation: triggers, conditions and actions](../architecture/0009-workflow-triggers-conditions-actions.md);
where this page and 0009 disagree, this page describes what shipped, and the differences are
called out under [Deviations from 0009](#deviations-from-0009).

For supervisors writing workflows in the console rather than calling the API, read
[Automate what happens to a ticket](../guides/automate-tickets-with-workflows.md).

## Conventions

| Concern           | Rule                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| Base path         | `/api/v1`                                                                               |
| Tenant            | Resolved from the request `Host`, never from a body, header or query parameter          |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                         |
| Lists             | `{ items, nextCursor }`. The workflow list does **not** paginate; the run list **does** |
| Timestamps        | ISO 8601 with an explicit offset                                                        |
| Error shape       | The standard envelope, with a code from `packages/contracts/src/error-codes.ts`         |
| `Idempotency-Key` | Not used here. Nothing on this surface has an external side effect                      |

**The asymmetry between the two lists is the point.** `workflowsPerTenant` is enforced on
create and the evaluator loads the matching set whole per occurrence anyway, so an unbounded
workflow list is a promise the server can keep; `nextCursor` stays in the shape and stays
`null`, so a generic list client works unchanged. Runs grow with ticket volume × active
workflows, which is exactly the unbounded set 0002's pagination rule exists for.

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
| The workflow is in another tenant                | `404 not_found`       |

## Permissions

| Route                              | Permission       | Held by           |
| ---------------------------------- | ---------------- | ----------------- |
| `GET /api/v1/workflows`            | `workflow:read`  | supervisor, admin |
| `POST /api/v1/workflows`           | `workflow:write` | supervisor, admin |
| `GET /api/v1/workflows/{id}`       | `workflow:read`  | supervisor, admin |
| `PATCH /api/v1/workflows/{id}`     | `workflow:write` | supervisor, admin |
| `DELETE /api/v1/workflows/{id}`    | `workflow:write` | supervisor, admin |
| `POST /api/v1/workflows/reorder`   | `workflow:write` | supervisor, admin |
| `POST /api/v1/workflows/{id}/test` | `workflow:write` | supervisor, admin |
| `GET /api/v1/workflows/{id}/runs`  | `workflow:read`  | supervisor, admin |
| `GET /api/v1/workflow-catalog`     | `workflow:read`  | supervisor, admin |

**`workflow:read` and `workflow:write` reached supervisor with this story.** ADR 0004
granted them to admin only, on the reason that a workflow "can send messages autonomously",
so a misconfigured one is a mass-messaging incident. That is right about the risk it names
and does not apply to the launch action set: `add_ticket_tag`, `reassign`, `notify`,
`set_status` and `set_priority` are all **internal**, and a supervisor can already perform
every one of them by hand with `ticket:update`, `ticket:assign` and `ticket:read_all` on
tickets they can already see. Automating them changes the speed, not the blast radius.

**The rule this fixes for whoever adds the first outbound action:** any workflow action that
sends a message to a customer requires a separate `workflow:send_message`, admin-only,
checked at **workflow-write time on the action type** — never at execution time. A workflow
runs with no principal, so there is nobody to check against when it fires; the permission is
a property of the person who armed it.

**The dry run requires `workflow:write`, not `workflow:read`.** It reads one ticket the
caller may not otherwise be entitled to see, and reporting "condition held: assigned to
Sara" against a ticket they cannot open would be a read-scope bypass. The service still
checks `ticket:read_all` on the named ticket rather than assuming this permission implies
it, because the permission table is data and could change underneath the assumption.

## The workflow

```json
{
  "id": "019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa",
  "name": "Escalate stale tickets",
  "position": 0,
  "isActive": true,
  "brokenReason": null,
  "version": 3,
  "trigger": { "type": "ticket_unresolved_for", "minutes": 240 },
  "conditions": [{ "type": "ticket_status", "operator": "in", "values": ["open"] }],
  "actions": [
    { "type": "add_ticket_tag", "tagId": "019fed85-1a20-7c31-9b04-8f2ad51c7e10" },
    {
      "type": "notify",
      "audience": "supervisors",
      "userId": null,
      "teamId": null,
      "message": "Still unresolved after four hours."
    }
  ],
  "references": [
    {
      "kind": "tag",
      "id": "019fed85-1a20-7c31-9b04-8f2ad51c7e10",
      "name": "escalated",
      "exists": true
    }
  ],
  "createdAt": "2026-08-18T09:14:02.118+03:00",
  "updatedAt": "2026-08-20T11:02:47.903+03:00"
}
```

| Field          | Type             | Notes                                                                                                            |
| -------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `name`         | string, 1–80     | Unique per tenant, **case-insensitively** — the column is `citext`                                               |
| `position`     | integer ≥ 0      | Ascending **execution** order. Ties break on `id`, which is creation order                                       |
| `isActive`     | boolean          | `false` takes the workflow out of evaluation and leaves it in the list. Defaults to `false`                      |
| `brokenReason` | string or `null` | `reference_removed`, `reference_suspended` or `reference_missing`. Non-null only on an auto-deactivated workflow |
| `version`      | integer ≥ 1      | Increments when `trigger`, `conditions` or `actions` change. Copied onto every run                               |
| `trigger`      | object           | Exactly one. See [Triggers](#triggers)                                                                           |
| `conditions`   | array, 0–10      | All must hold. **Empty is legal** and matches every occurrence                                                   |
| `actions`      | array, 1–5       | Executed in the declared order. At least one is required                                                         |
| `references`   | array            | Every taxonomy id the definition names, resolved live. See [References](#references-and-the-taxonomy)            |
| `createdAt`    | timestamp        |                                                                                                                  |
| `updatedAt`    | timestamp        |                                                                                                                  |

**`isActive` defaults to `false` on create, unlike an assignment rule.** A rule that writes
to tickets is armed on purpose, and the flow the console produces is create → dry-run →
enable.

**`version` moves only when execution changed.** Renaming a workflow, moving it, or turning
it on or off does not bump it, because nothing about _what the workflow does_ moved. Every
run copies the version that fired, so a supervisor reading a run can tell whether the
definition in front of them is the one that produced it — and a rename that bumped the
version would make that signal noisy for no gain.

### Limits

Published as `WORKFLOW_LIMITS` in `packages/contracts/src/workflows.ts` and served by
[`GET /api/v1/workflow-catalog`](#get-apiv1workflow-catalog), so the API, the console and
0009 cannot drift.

| Limit                              | Value | Covers                                                                                    |
| ---------------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| `workflowsPerTenant`               | 50    | Active and inactive together                                                              |
| `conditionsPerWorkflow`            | 10    | Conditions in one workflow, all of which must hold                                        |
| `actionsPerWorkflow`               | 5     | Actions in one workflow                                                                   |
| `valuesPerCondition`               | 25    | Tag ids in one `ticket_tag` or `contact_tag` condition                                    |
| `elapsedTriggerWorkflowsPerTenant` | 10    | Workflows carrying `ticket_unresolved_for`                                                |
| `runsPerTicketPerHour`             | 20    | Runs one ticket may produce in one hour, across every workflow                            |
| `maxChainDepth`                    | 3     | How deep a chain of workflow-caused triggers may go                                       |
| `runsRetentionDays`                | 90    | Intended retention for `workflow_runs`. **Not yet swept** — see [Known gaps](#known-gaps) |

None of the first five is a limit a real tenant meets. They exist because evaluating one
triggering occurrence costs `workflows × conditions`, and because the workflow list returns
the whole set.

**The elapsed cap is separate and lower because each elapsed workflow is sweep work.** An
event trigger costs nothing until it fires; a `ticket_unresolved_for` threshold is something
the sweep has to consider on every tick.

Field lengths are `WORKFLOW_FIELD_LENGTHS`: `name` 80 characters, `notify.message` 280.
The elapsed window is `WORKFLOW_ELAPSED_MINUTES`: 5 minutes to 43 200 (30 days).

### Triggers

A workflow has exactly one trigger. Four are events; one is a time becoming true.

| Type                    | Fires on                                                               | Raised by                                         |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| `ticket_created`        | A ticket row was created                                               | `TicketQueueRunner`, after the linker creates one |
| `ticket_status_changed` | A `status_changed` ticket event was written, by an agent or the system | `TicketCommandService`                            |
| `ticket_assigned`       | An `assigned` or `unassigned` ticket event was written                 | `TicketCommandService`                            |
| `ticket_sla_breached`   | An SLA timer flipped to `breached` and its alerts committed            | `SlaSweepService`                                 |
| `ticket_unresolved_for` | The ticket has been active for at least `minutes`                      | `WorkflowElapsedSweep`                            |

`ticket_unresolved_for` is the only trigger that carries a parameter:

```json
{ "type": "ticket_unresolved_for", "minutes": 240 }
```

`minutes` is an integer, 5 to 43 200 inclusive. The floor is the sweep interval's promise —
below one tick, "escalate after N minutes" is a deadline the sweep cannot keep.

**Every trigger is enqueued after the transaction that produced it commits.** A failure to
enqueue is logged, not thrown: the ticket write is committed and its caller is owed their 200. See [Known gaps](#known-gaps) — event triggers have no reconciler.

### The condition grammar

**Conditions inside one workflow combine with AND. There is no OR, no workflow-level
`any`/`all` toggle, and no nesting.** A supervisor wanting OR writes two workflows, because
every matching workflow runs. A tree the rule-list UI cannot render would be a grammar the
API validated for ever without a caller.

**An empty condition list matches**, unlike a routing rule's. "Every time this trigger
fires, do this" is a legitimate automation and cannot swallow anything, because every other
workflow still runs.

**A condition with no data to read is false.** It never throws and it never matches.

| Type                | Reads                                               | Shape                                                       |
| ------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `ticket_status`     | `tickets.status`                                    | `operator`: `in` \| `not_in`; `values`: 1–4 statuses        |
| `ticket_priority`   | `tickets.priority`                                  | `operator`: `in` \| `not_in`; `values`: 1–4 priorities      |
| `ticket_assignment` | `tickets.assigned_user_id`, `.assigned_team_id`     | `state`, plus an optional `teamId` or `userId` narrowing it |
| `ticket_tag`        | `ticket_tags` for the ticket                        | `match`: `any` \| `all` \| `none`; `tagIds`: 1–25           |
| `contact_tag`       | `contact_tags` for the ticket's contact             | `match`: `any` \| `all` \| `none`; `tagIds`: 1–25           |
| `ticket_age`        | Minutes since `tickets.created_at`, against `now()` | `operator`: `gte` \| `lte`; `minutes`: 1–43 200             |
| `business_hours`    | `tenant_settings.business_hours` and `.timezone`    | `within`: boolean                                           |

```json
[
  { "type": "ticket_status", "operator": "in", "values": ["open", "pending"] },
  { "type": "ticket_assignment", "state": "unassigned", "teamId": null, "userId": null },
  { "type": "contact_tag", "match": "any", "tagIds": ["019fed85-1a20-7c31-9b04-8f2ad51c7e10"] },
  { "type": "ticket_age", "operator": "gte", "minutes": 120 },
  { "type": "business_hours", "within": false }
]
```

**`ticket_assignment` states, and what narrowing them means.** `state` is `unassigned`,
`assigned_to_user` or `assigned_to_team`. `teamId` and `userId` default to `null`, which
means "any" — so `assigned_to_user` with no `userId` reads "somebody holds this", the common
case. The schema refuses the combinations that would contradict the state: `unassigned` with
either id, `assigned_to_user` with a `teamId`, `assigned_to_team` with a `userId`.

A ticket assigned to a user _and_ a team satisfies both `assigned_to_user` and
`assigned_to_team`, deliberately: both statements are true of it, and a rule asking "is
anybody on this" should not turn false because a team is named too.

**`none` exists here and does not in the routing grammar**, and it is the one place this
grammar is wider. A routing rule can express a negation by being placed later in a
first-match list; a workflow list has no first-match ordering to express it with, so the
negation has to be in the grammar.

**`ticket_age` is inclusive at both ends.** `gte` is "at least this old", `lte` is "at most
this old". Inclusive is the only reading under which a threshold of exactly `minutes` ever
fires: the sweep's own predicate is `created_at <= now() - interval`, so a ticket arrives
having just reached the bound, never having passed it.

**`business_hours` refuses to guess**, on the same rule as routing. When the tenant has no
configured hours, or the stored value does not parse, the condition is **false whichever way
`within` is set** — and the dry run reports `business_hours_unconfigured` rather than a bare
`false`. Semantics come from `isWithinBusinessHours` in `packages/contracts/src/tenant.ts`,
unchanged.

**`contact_tag` distinguishes "no contact" from "a contact with no tags".** The first is
unreadable and reports `no_contact`; the second is an empty set, which `none` is legitimately
true of.

### The action set

Exactly the five TAR-27 commits to. Actions run **sequentially, in the declared order, each
in its own transaction**, and **a failure stops the rest**.

| Type             | Fields                                                             | What it writes                                          |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `add_ticket_tag` | `tagId`                                                            | A `ticket_tags` row. A workflow never creates a tag     |
| `reassign`       | `target`: `{ kind: 'team', teamId }` or `{ kind: 'user', userId }` | The ticket's assignment, through `TicketCommandService` |
| `notify`         | `audience`, `userId`, `teamId`, `message`                          | One `notifications` row per recipient                   |
| `set_status`     | `status`                                                           | The ticket's status, through `TicketCommandService`     |
| `set_priority`   | `priority`                                                         | The ticket's priority, through `TicketCommandService`   |

**The action list is not wrapped in one transaction**, and a partial result is the honest
one: if the ticket was tagged and the notification failed, "tagged, notification failed" is
what happened, and a run row claiming nothing happened would be a lie a supervisor debugs
against. **Stopping rather than continuing** is the conservative half — actions are usually
ordered because the later ones assume the earlier ones ("reassign to the escalation team,
then notify that team"), and running the notify after the reassign failed tells somebody
about work they did not receive.

`notify` takes an audience and the id that audience needs:

| `audience`    | Requires | Recipients                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------------ |
| `supervisors` | neither  | The ticket-holder's supervisors, resolved as ADR 0006 decision 4 resolves them |
| `user`        | `userId` | That user, if **active**                                                       |
| `team`        | `teamId` | Every **active** member of that team                                           |

The schema refuses a `userId` on any audience but `user`, and a `teamId` on any but `team`.
`message` is optional, at most 280 characters, and is **shown verbatim** — there is no
interpolation at v1.

**Nobody to tell is `no_op`, not a failure.** A tenant whose only supervisor was suspended
gets a `no_op` result and a warning naming the ticket: the automation ran and there was no
audience, which is a fact a supervisor may need but is not something to mark the run failed
for.

**A `reassign` or `notify` target is re-read in tenant scope, and only `active` users
qualify.** A removed account cannot answer, a suspended one has had its access cut, and an
`invited` user has no session to open the ticket with — so escalating to any of them would
look like a fix and be a second deferral. A target that no longer resolves fails the action
with `reference_missing`, which deactivates the workflow.

### References and the taxonomy

**A definition stores taxonomy ids and only ids. Names are resolved live, at read time, and
never stored.**

That is TAR-27's second acceptance criterion made structural rather than maintained by a
code path. A rename therefore requires no migration, no backfill and no cache bust, and
`exists: false` is what makes breakage _visible_ — the console renders a broken reference in
the rule list without a second request. A response embedding a stored name would show the
old one and look healthy.

```json
{ "kind": "tag", "id": "019fed85-1a20-7c31-9b04-8f2ad51c7e10", "name": "escalated", "exists": true }
```

| Field    | Notes                                       |
| -------- | ------------------------------------------- |
| `kind`   | `tag`, `team` or `user`                     |
| `id`     | The id as the definition names it           |
| `name`   | Null exactly when `exists` is false         |
| `exists` | Whether a live, tenant-scoped read found it |

**A reference to a non-`active` user resolves to nothing**, and that is deliberate. Removal
is a status change rather than a delete, so a name lookup with no status filter would still
find a removed user, report `exists: true`, and let a supervisor re-arm a workflow that then
fails on its first ticket — a loop rather than a one-off failure. `REFERENCEABLE_USER` is
the one predicate both the resolve path and the executor read. Tags and teams carry no
status, so for them "in this tenant" is the whole of "referenceable".

**Deletes are refused by PostgreSQL, not by a cross-module call.** `workflow_references`
carries real composite foreign keys on `(tenant_id, id)`, so a tag or team a workflow names
cannot be deleted while it names it. Removing a **user** still always succeeds — it is a
security action — and leaves every workflow naming them deactivated with
`brokenReason: 'reference_removed'` and its reference rows dropped, inside the removal
transaction.

**Suspending a user disarms them too**, with `brokenReason: 'reference_suspended'` and inside
the status-change transaction (TAR-596). It has to: `REFERENCEABLE_USER` is `active`, so a
suspension leaves every workflow naming that person armed against an actor the executor will
refuse to use — and before this the first ticket to reach one failed `reference_missing` and
auto-deactivated it anyway, which meant the admin who caused it found out from a customer.
The reference rows **stay**, unlike on removal: the account is still there and still
reinstatable, so the console keeps reporting which field names whom. Reactivating the person
does not re-arm anything — `brokenReason` clears on the next write once every reference
resolves, and a human with `workflow:write` sends `isActive: true`.

**`workflow_references` carries only the references that resolve.** The reverse index exists
to make a delete refusable, and a row already gone needs no protection; its composite foreign
key would refuse the insert outright. The dangling id stays in `definition`, which is where
the response reads it from to report `exists: false`.

**`brokenReason` is derived state, not a latch.** Every write recomputes the post-patch
reference set and clears it when they all resolve, independent of `isActive`. The invariant
this establishes — `brokenReason IS NOT NULL` implies at least one reference does not
resolve — is what makes the field safe to render and safe to ignore as a gate. Arming is
refused when, and only when, some post-patch reference does not resolve.

## `GET /api/v1/workflows`

The tenant's whole workflow set, in execution order — `position` ascending, ties broken on
`id`. Active and inactive together. Takes no parameters.

```bash
curl -b cookies.txt https://acme.app.example.com/api/v1/workflows
```

```json
{
  "items": [
    {
      "id": "019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa",
      "name": "Escalate stale tickets",
      "position": 0,
      "isActive": true,
      "brokenReason": null,
      "version": 3,
      "trigger": { "type": "ticket_unresolved_for", "minutes": 240 },
      "conditions": [{ "type": "ticket_status", "operator": "in", "values": ["open"] }],
      "actions": [
        {
          "type": "notify",
          "audience": "supervisors",
          "userId": null,
          "teamId": null,
          "message": null
        }
      ],
      "references": [],
      "createdAt": "2026-08-18T09:14:02.118+03:00",
      "updatedAt": "2026-08-20T11:02:47.903+03:00"
    }
  ],
  "nextCursor": null
}
```

| Status | Code              | Cause              |
| ------ | ----------------- | ------------------ |
| `200`  | —                 |                    |
| `401`  | `unauthenticated` | No session         |
| `403`  | `forbidden`       | No `workflow:read` |

`nextCursor` is always `null`. The order this returns is the order the evaluator executes
in, out of the same index — a list showing a different order from the one that runs would be
worse than no list.

## `POST /api/v1/workflows`

Creates a workflow.

**Idempotency.** No `Idempotency-Key`. This writes one row and has no external side effect.
Replaying the call creates a second workflow, or answers `409 conflict` on the duplicate
name.

| Parameter    | In   | Type    | Required | Default | Notes                                                  |
| ------------ | ---- | ------- | -------- | ------- | ------------------------------------------------------ |
| `name`       | body | string  | yes      | —       | 1–80 characters, unique per tenant, case-insensitively |
| `trigger`    | body | object  | yes      | —       | One of the five trigger types                          |
| `actions`    | body | array   | yes      | —       | 1–5 actions, executed in order                         |
| `conditions` | body | array   | no       | `[]`    | 0–10 conditions, all of which must hold                |
| `position`   | body | integer | no       | last    | Ascending; ties break on creation order                |
| `isActive`   | body | boolean | no       | `false` | A rule that writes to tickets is armed on purpose      |

```bash
curl -X POST https://acme.app.example.com/api/v1/workflows \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{
        "name": "Escalate stale tickets",
        "trigger": { "type": "ticket_unresolved_for", "minutes": 240 },
        "conditions": [
          { "type": "ticket_status", "operator": "in", "values": ["open"] }
        ],
        "actions": [
          { "type": "add_ticket_tag", "tagId": "019fed85-1a20-7c31-9b04-8f2ad51c7e10" },
          { "type": "notify", "audience": "supervisors", "message": "Still unresolved after four hours." }
        ]
      }'
```

```json
{
  "id": "019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa",
  "name": "Escalate stale tickets",
  "position": 3,
  "isActive": false,
  "brokenReason": null,
  "version": 1,
  "trigger": { "type": "ticket_unresolved_for", "minutes": 240 },
  "conditions": [{ "type": "ticket_status", "operator": "in", "values": ["open"] }],
  "actions": [
    { "type": "add_ticket_tag", "tagId": "019fed85-1a20-7c31-9b04-8f2ad51c7e10" },
    {
      "type": "notify",
      "audience": "supervisors",
      "userId": null,
      "teamId": null,
      "message": "Still unresolved after four hours."
    }
  ],
  "references": [
    {
      "kind": "tag",
      "id": "019fed85-1a20-7c31-9b04-8f2ad51c7e10",
      "name": "escalated",
      "exists": true
    }
  ],
  "createdAt": "2026-08-20T11:02:47.903+03:00",
  "updatedAt": "2026-08-20T11:02:47.903+03:00"
}
```

| Status | Code                | Cause                                                                                                  |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `201`  | —                   |                                                                                                        |
| `400`  | `validation_failed` | Grammar, an empty `actions`, a mismatched `notify` audience and id, a tag/team/user not in this tenant |
| `401`  | `unauthenticated`   | No session                                                                                             |
| `403`  | `forbidden`         | No `workflow:write`                                                                                    |
| `409`  | `conflict`          | Duplicate `name`, `workflowsPerTenant` reached, or `elapsedTriggerWorkflowsPerTenant` reached          |

`validation_failed` carries `details` naming the field, by its path in the definition:
`actions.0.tagId`, `conditions.1.teamId`.

**An unknown reference on create is `validation_failed`, never `not_found` or
`workflow_reference_broken`.** Row-level security means another tenant's team is simply not
visible, so the server genuinely cannot tell it from a team that never existed — and that
indistinguishability is the point. On a create every id was just chosen by the caller, so
one that resolves to nothing is a typo, not a reference to repair.

**The cap is checked, then the row is written**, so two creates racing at the boundary can
both pass and leave the tenant one workflow over 50. Accepted rather than locked: the
consequence is a 51st workflow on a bound that exists to keep per-occurrence evaluation
cheap, not a correctness failure.

**`position` omitted appends the workflow last** — `max(position) + 1`, or `0` for the
first. A `position` supplied explicitly is written as given and shifts nothing, so it can
tie with an existing workflow; the tie breaks on `id`, so the new workflow executes after the
existing one. Use `reorder` to place a workflow between two others.

## `GET /api/v1/workflows/{id}`

One workflow, with its references resolved.

| Status | Code                | Cause                                    |
| ------ | ------------------- | ---------------------------------------- |
| `200`  | —                   |                                          |
| `400`  | `validation_failed` | `{id}` is not a UUID                     |
| `401`  | `unauthenticated`   | No session                               |
| `403`  | `forbidden`         | No `workflow:read`                       |
| `404`  | `not_found`         | Unknown id, or another tenant's workflow |

**Everyone holding `workflow:read` sees every workflow in the tenant.** Workflows are tenant
configuration, not assignable records, so the visibility predicate that scopes conversations
and tickets to their assignee does not apply. Isolation is the tenant boundary alone.

## `PATCH /api/v1/workflows/{id}`

Partial update. **Absent means unchanged, for every field** — there are no server-side
defaults on this schema, deliberately, because a partial built from the create schema would
leave `conditions` defaulting to `[]` and a supervisor arming a workflow from the list would
silently delete every condition it had.

| Parameter    | In   | Type    | Required | Notes                                          |
| ------------ | ---- | ------- | -------- | ---------------------------------------------- |
| `name`       | body | string  | no       | 1–80 characters                                |
| `trigger`    | body | object  | no       | Replaces the trigger whole                     |
| `conditions` | body | array   | no       | Replaces the list whole, 0–10                  |
| `actions`    | body | array   | no       | Replaces the list whole, 1–5                   |
| `position`   | body | integer | no       | Moves this workflow and shifts those it passes |
| `isActive`   | body | boolean | no       | Arming re-checks every reference               |

```bash
curl -X PATCH https://acme.app.example.com/api/v1/workflows/019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{ "isActive": true }'
```

| Status | Code                        | Cause                                                                               |
| ------ | --------------------------- | ----------------------------------------------------------------------------------- |
| `200`  | —                           |                                                                                     |
| `400`  | `validation_failed`         | Grammar, or `{id}` is not a UUID                                                    |
| `400`  | `workflow_reference_broken` | `isActive: true` while some reference in the post-patch definition does not resolve |
| `401`  | `unauthenticated`           | No session                                                                          |
| `403`  | `forbidden`                 | No `workflow:write`                                                                 |
| `404`  | `not_found`                 | Unknown id, or another tenant's workflow                                            |
| `409`  | `conflict`                  | Duplicate `name`, or `elapsedTriggerWorkflowsPerTenant` reached by the new trigger  |

`workflow_reference_broken` carries `details` naming each broken reference by its path —
`actions.1.tagId` — with the message `This tag no longer exists.`, so the console highlights
the exact field rather than the rule.

**An unresolved reference on an update is not refused.** The asymmetry with create is the
point: here the dead id is the thing being repaired, and refusing the write would make the
repair impossible — the workflow cannot be saved at all while the id it is being edited to
replace is still in the definition. So `update` resolves without refusing and gates
**arming** instead.

**The check runs against the workflow as it will be after the patch**, so replacing a broken
reference and enabling in one call is allowed, and enabling without replacing it is refused.

**The two-step repair the console produces works.** Its edit form carries `isActive` through
unchanged — arming is a deliberate act on the list rather than a side effect of saving an
edit — so the repair `PATCH` is always `isActive: false`. That write clears `brokenReason`
because the post-patch references now all resolve; the supervisor then enables from the list,
and that request re-checks every reference. There is no path on which a rule nobody looked at
starts running by itself.

**The elapsed cap excludes the workflow being edited**, so changing the threshold on an
existing `ticket_unresolved_for` workflow is never refused for being one.

## `DELETE /api/v1/workflows/{id}`

`204`, and idempotent: deleting an already-deleted workflow is `204`, not `404`.

| Status | Code                | Cause                |
| ------ | ------------------- | -------------------- |
| `204`  | —                   |                      |
| `400`  | `validation_failed` | `{id}` is not a UUID |
| `401`  | `unauthenticated`   | No session           |
| `403`  | `forbidden`         | No `workflow:write`  |

`workflow_runs` and `workflow_references` cascade, so the reverse index a taxonomy delete
consults empties with the workflow — a tag whose only referencing workflow was just deleted
is immediately deletable. **The run history goes with it**, which is the one thing to know
before deleting rather than disabling.

Positions of the remaining workflows are left alone. Gaps are harmless, because the order is
the sort and not the values, and closing them would rewrite every row after the deleted one
for no behaviour change.

## `POST /api/v1/workflows/reorder`

Rewrites `position` to the array index, in one transaction. `200`, returning the whole list
in its new order.

| Parameter     | In   | Type  | Required | Notes                                                   |
| ------------- | ---- | ----- | -------- | ------------------------------------------------------- |
| `workflowIds` | body | array | yes      | The tenant's **complete** set, in execution order, ≤ 50 |

```bash
curl -X POST https://acme.app.example.com/api/v1/workflows/reorder \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{ "workflowIds": ["019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa", "019fee02-8b41-7a0d-b3c6-1e7f9a2d4c88"] }'
```

| Status | Code                | Cause                                                          |
| ------ | ------------------- | -------------------------------------------------------------- |
| `200`  | —                   |                                                                |
| `400`  | `validation_failed` | More than 50 ids, or an entry that is not a UUID               |
| `401`  | `unauthenticated`   | No session                                                     |
| `403`  | `forbidden`         | No `workflow:write`                                            |
| `409`  | `conflict`          | `workflowIds` is not exactly the tenant's current workflow set |

**The complete set rather than a delta buys optimistic concurrency for free.** A submitted
set that is not exactly the current one means somebody else created or deleted a workflow
since this client loaded the page, and the honest answer is `conflict` rather than a silent
partial reorder. A repeated id that omits another fails the same check, for the same reason
a missing one does — the schema caps the array's length and does not assert uniqueness, so
this is where that is caught.

**Declared before `GET /workflows/{id}` in the controller.** Nest matches routes in
declaration order, so `reorder` would otherwise be read as an id and answer
`validation_failed` for a route that exists.

## `POST /api/v1/workflows/{id}/test`

The dry run. Evaluates this workflow's conditions against a real ticket's real fact sheet and
reports what **would** happen.

**It writes nothing** — no `workflow_runs` row, no ticket write, no notification, no socket.
Deliberately not "run it for real once": a supervisor testing a rule that closes tickets
should not close one, and there is no way to un-close it. The rejected shape — a
`commit: boolean` on this endpoint — is one typo away from a live write on a surface whose
whole purpose is safety.

**It ignores the trigger.** Only the conditions are evaluated; `matched` answers "would this
workflow's conditions hold on this ticket", not "would this workflow fire on this ticket".

| Parameter  | In   | Type   | Required | Notes                          |
| ---------- | ---- | ------ | -------- | ------------------------------ |
| `ticketId` | body | string | yes      | A ticket visible to the caller |

```bash
curl -X POST https://acme.app.example.com/api/v1/workflows/019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa/test \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{ "ticketId": "019fedb2-77c4-7e19-a5f2-0d3b81ce6042" }'
```

```json
{
  "matched": true,
  "conditions": [{ "index": 0, "type": "ticket_status", "held": true, "reason": null }],
  "actions": [
    {
      "index": 0,
      "type": "add_ticket_tag",
      "outcome": "applied",
      "describes": "Tag the ticket \"escalated\""
    },
    {
      "index": 1,
      "type": "notify",
      "outcome": "applied",
      "describes": "Notify the ticket-holder's supervisors"
    }
  ]
}
```

| Status | Code                | Cause                                                    |
| ------ | ------------------- | -------------------------------------------------------- |
| `200`  | —                   |                                                          |
| `400`  | `validation_failed` | `{id}` or `ticketId` is not a UUID                       |
| `401`  | `unauthenticated`   | No session                                               |
| `403`  | `forbidden`         | No `workflow:write`                                      |
| `404`  | `not_found`         | Unknown workflow, or a ticket not visible to this caller |

**A ticket the caller cannot see is `not_found`, never `forbidden`** — a 403 would confirm
the id names a real ticket. A caller lacking `ticket:read_all` gets the same answer.

`conditions[].reason` is non-null only when a condition had **no data to read**, which is a
different fact from "it read the data and did not match". The closed set the server emits is
`no_contact` and `business_hours_unconfigured`.

`actions` is empty when `matched` is false — listing actions beside `matched: false` invites
the reader to think they ran. `outcome` here means "would apply" (`applied`) or "the ticket
is already in that state" (`no_op`), computed from the same fact sheet the real run uses.
`reassign` and `notify` always report `applied`: the first is a last-writer-wins column this
preview would have to re-derive the assignment rules to predict, and the second always writes
a row when it has an audience.

`describes` is the human-readable sentence with ids resolved — `Reassign to team
"Escalations"`. A broken reference reads as `a tag that no longer exists` rather than as a
bare UUID.

## `GET /api/v1/workflows/{id}/runs`

One workflow's runs, newest first. **This is the first thing to read when a workflow looks
wrong, before its definition** — it says whether the workflow ran, which conditions held and
what each action did.

| Parameter | In    | Type    | Required | Default        | Notes                        |
| --------- | ----- | ------- | -------- | -------------- | ---------------------------- |
| `limit`   | query | integer | no       | 0002's default | Page size                    |
| `cursor`  | query | string  | no       | —              | Opaque, minted by this list  |
| `status`  | query | string  | no       | —              | One of the five run statuses |

```bash
curl -b cookies.txt \
  'https://acme.app.example.com/api/v1/workflows/019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa/runs?status=failed'
```

```json
{
  "items": [
    {
      "id": "019fee0a-52d1-7c88-9e03-4b6a2f19d7c5",
      "workflowId": "019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa",
      "workflowVersion": 3,
      "ticketId": "019fedb2-77c4-7e19-a5f2-0d3b81ce6042",
      "ticketNumber": 1284,
      "status": "failed",
      "triggerType": "ticket_unresolved_for",
      "results": [
        { "index": 0, "type": "add_ticket_tag", "outcome": "applied", "reason": null },
        { "index": 1, "type": "reassign", "outcome": "failed", "reason": "reference_missing" }
      ],
      "failureReason": "reference_missing",
      "startedAt": "2026-08-20T13:10:04.221+03:00",
      "finishedAt": "2026-08-20T13:10:04.688+03:00",
      "createdAt": "2026-08-20T13:10:04.190+03:00"
    }
  ],
  "nextCursor": null
}
```

| Status | Code                | Cause                                                                         |
| ------ | ------------------- | ----------------------------------------------------------------------------- |
| `200`  | —                   |                                                                               |
| `400`  | `validation_failed` | `{id}` is not a UUID, an unknown `status`, or a cursor this list did not mint |
| `401`  | `unauthenticated`   | No session                                                                    |
| `403`  | `forbidden`         | No `workflow:read`                                                            |
| `404`  | `not_found`         | Unknown workflow, or another tenant's                                         |

Keyset paginated on `(created_at DESC, id DESC)`, served by
`workflow_runs (tenant_id, workflow_id, created_at DESC, id DESC)`.

**A run list for a workflow the caller cannot see is `not_found` on the workflow, never an
empty page.** An empty page would be indistinguishable from a workflow that has never fired,
which is the question the caller is asking.

### Run statuses

| Status      | Means                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| `pending`   | Claimed, not yet started                                                     |
| `running`   | Actions are executing                                                        |
| `succeeded` | Conditions matched and every action finished without failing                 |
| `skipped`   | Conditions did not match. **Not a failure** — it is the answer to "why not?" |
| `failed`    | An action failed, or the run could not proceed. `failureReason` says which   |

### Failure reasons

| Reason                | Cause                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- |
| `reference_missing`   | A tag, team or user the definition names no longer exists. **Deactivates the workflow** |
| `transition_refused`  | `TICKET_STATUS_TRANSITIONS` refuses the move — reopening a closed ticket                |
| `ticket_gone`         | The ticket was deleted, or is no longer visible, between the claim and the action       |
| `run_budget_exceeded` | The ticket hit `runsPerTicketPerHour`. Loop protection, not a fault                     |
| `internal_error`      | Everything else. The run carries the name; the log line carries the stack               |

### Action outcomes

`results` carries one entry per action attempted, keyed by its `index` in the definition, so
a result maps back to what was written. `results` is empty on `skipped` — nothing was
attempted.

| Outcome   | Means                                                                           |
| --------- | ------------------------------------------------------------------------------- |
| `applied` | The write happened                                                              |
| `no_op`   | Nothing to change: the status was already that, the tag already on it           |
| `failed`  | Attempted and did not happen. `reason` is a failure reason from the table above |
| `skipped` | An earlier action failed, so this one was not attempted                         |

**`no_op` is not `applied`**, and the distinction answers half the questions a supervisor
brings: "it ran and changed nothing" is a different fact from "it did not run".

`workflowVersion` is copied onto the run rather than joined, so a run says which definition
fired even after the definition has been edited.

## `GET /api/v1/workflow-catalog`

The vocabulary the **server** will accept, so a builder cannot offer an action the API
refuses. Takes no parameters.

```bash
curl -b cookies.txt https://acme.app.example.com/api/v1/workflow-catalog
```

```json
{
  "triggers": [
    {
      "type": "ticket_unresolved_for",
      "parameters": [
        {
          "name": "minutes",
          "kind": "int",
          "isRequired": true,
          "min": 5,
          "max": 43200,
          "values": null,
          "taxonomy": null
        }
      ],
      "conditionTypes": [
        "ticket_status",
        "ticket_priority",
        "ticket_assignment",
        "ticket_tag",
        "contact_tag",
        "ticket_age",
        "business_hours"
      ]
    }
  ],
  "conditions": [
    { "type": "ticket_tag", "operators": ["any", "all", "none"], "taxonomy": "tag", "values": null }
  ],
  "actions": [
    {
      "type": "set_priority",
      "parameters": [
        {
          "name": "priority",
          "kind": "enum",
          "isRequired": true,
          "min": null,
          "max": null,
          "values": ["low", "normal", "high", "urgent"],
          "taxonomy": null
        }
      ]
    }
  ],
  "limits": {
    "workflowsPerTenant": 50,
    "conditionsPerWorkflow": 10,
    "actionsPerWorkflow": 5,
    "valuesPerCondition": 25,
    "elapsedTriggerWorkflowsPerTenant": 10,
    "runsPerTicketPerHour": 20,
    "maxChainDepth": 3,
    "runsRetentionDays": 90
  }
}
```

The example above is abridged to one member per list; the real response carries all five
triggers, all seven condition types and all five action types.

| Status | Code              | Cause              |
| ------ | ----------------- | ------------------ |
| `200`  | —                 |                    |
| `401`  | `unauthenticated` | No session         |
| `403`  | `forbidden`       | No `workflow:read` |

**One endpoint rather than three listings.** A form needs all of it before it can render
anything, and three endpoints would be three round trips that always happen together and can
disagree across a deploy.

**It publishes no tenant data at all** — only the server's own vocabulary — which is why
`workflow:read` is enough. The taxonomy the pickers fill from is read separately, from
`GET /api/v1/tags`, `/teams` and `/users`.

**The body is built from the same constants the API validates against**, by `workflowCatalog()`
in `packages/contracts/src/workflows.ts`, so the API's answer and the console's mock
transport are the same object rather than two transcriptions.

`conditions[].operators` is empty for `ticket_assignment` and `business_hours`: neither
compares. `conditions[].taxonomy` tells the console which picker to render, and is `null` for
`ticket_assignment` even though it takes ids — narrowing a state takes _either_ a team or a
user, so the condition names no single taxonomy and the form renders both, gated on state.

## Auditing

Every write records an `audit_logs` row with `target_type = 'workflow'`.

| Action                 | Written when                                          | Actor  |
| ---------------------- | ----------------------------------------------------- | ------ |
| `workflow.created`     | `POST /workflows`                                     | user   |
| `workflow.updated`     | `PATCH /workflows/{id}`, including a manual on/off    | user   |
| `workflow.deleted`     | `DELETE /workflows/{id}`                              | user   |
| `workflow.reordered`   | `POST /workflows/reorder`                             | user   |
| `workflow.deactivated` | The engine disarmed it after a reference went missing | `null` |

A workflow is a standing instruction that writes to tickets and messages supervisors without
anybody watching — the same class of change as a routing rule, which 0007 already audits.

**Metadata carries the workflow's name, its trigger type and its action types, never its
conditions.** A condition can carry tenant data, and the audit table is exported for
compliance review rather than being a place to discover it.

## How a workflow runs

Workflows are not applied by the CRUD surface. A triggering occurrence is enqueued as
`workflow.evaluate-ticket` on the `workflows` BullMQ queue **after the transaction that
produced it commits**, and `WorkflowQueueRunner` drives `WorkflowTriggerService` from it.

The sequence, per occurrence:

1. **Drop the job if it is too deep.** `depth > maxChainDepth` is logged once with the
   causing run id and the job ends. Checked first because it costs nothing.
2. **Re-read the ticket in tenant scope.** The trigger is a queue payload — unauthenticated
   input — so every id in it is re-read rather than trusted. A ticket that is not visible
   throws and the job retries; the realistic cause is the job overtaking the transaction
   that created its ticket.
3. **Load the active workflows whose `trigger_type` matches**, in execution order, out of
   `workflows (tenant_id, is_active, trigger_type, position, id)`.
4. **Read only the facts those workflows' conditions need**, once per ticket.
5. **For each candidate, claim a run, then evaluate.** See below.
6. **Execute the actions in order**, stopping at the first failure, and write the outcome of
   each onto the run row.

### Exactly once, per occurrence

**The row that records what a workflow did is the same row that reserves the right to do
it.**

```sql
INSERT INTO workflow_runs (…) VALUES (…)
ON CONFLICT (tenant_id, workflow_id, dedupe_key) DO NOTHING
RETURNING id;
```

One statement, one round trip, correct across replicas by construction. Nothing reads
`workflow_runs`, decides in TypeScript and then writes — the window between such a read and
its write is exactly the window two sweep ticks race in, and the bug it produces is a
duplicate escalation every minute.

No row returned means another replica, another sweep tick or an earlier delivery of this job
already owns the occurrence. The handler moves on and logs nothing: **a duplicate delivery is
the normal case, not an incident.**

The key carries no workflow id, so every workflow gets its own claim on the same occurrence
and they never collide with each other — which is what makes "every matching workflow runs"
true.

| Trigger                 | `dedupe_key`                              | Meaning                      |
| ----------------------- | ----------------------------------------- | ---------------------------- |
| `ticket_created`        | `ticket:{ticketId}:created`               | Once per ticket, ever        |
| `ticket_status_changed` | `ticket:{ticketId}:event:{ticketEventId}` | Once per recorded change     |
| `ticket_assigned`       | `ticket:{ticketId}:event:{ticketEventId}` | Once per recorded assignment |
| `ticket_sla_breached`   | `ticket:{ticketId}:timer:{slaTimerId}`    | Once per breached timer      |
| `ticket_unresolved_for` | `ticket:{ticketId}:elapsed`               | **Once per ticket, ever**    |

The last row is the one to read twice. A sweep re-evaluating the same overdue ticket every
minute would notify a supervisor every minute; this constraint is what stops it, and it stops
it whether or not the sweep is correct.

**The two ticket-scoped keys are namespaced apart, and the suffix is load-bearing.** A
workflow has one trigger at a time, so a bare `ticket:{id}` for both looks safe — but the
trigger is editable and `workflow_runs` rows survive the edit. A workflow that ran on 800
tickets as `ticket_created` and was then re-pointed at `ticket_unresolved_for` would find its
own earlier claims sitting on every one of those tickets and could never fire on any of them
again: silently, permanently, and with nothing in the run list to show for it, because no run
is ever claimed.

**These jobs carry no custom BullMQ id.** 0009 publishes a ticket-keyed
`workflowEvaluateJobId` as a third, explicitly non-load-bearing layer. On the pinned
`bullmq@6.0.10` that premise does not hold — `addStandardJob` answers `handleDuplicatedJob`
for a job hash key that `EXISTS` in _any_ state, and `removeOnComplete`/`removeOnFail` keep
thousands of keys alive. A ticket's id is stable for its whole life, so a ticket-keyed id
would collapse every occurrence after the first into the completed — or failed — key of the
one before it. Anything reintroducing an id must key it on the **occurrence**, never on the
ticket, and must account for the failed set as well as the completed one.

### The elapsed-trigger sweep

`ticket_unresolved_for` is a time becoming true rather than a request arriving, so something
has to notice. `WorkflowElapsedSweep` runs every `WORKFLOW_SWEEP_INTERVAL_MS` (default
60 000) and **writes nothing at all** — its entire output is jobs.

Phase 1 runs on `SystemPrisma`, which
[the tenant isolation contract](tenancy.md#why-the-workflow-elapsed-sweep-is-the-seventh)
records as the seventh permitted use: two read-only statements returning one aggregate and
two uuid columns, reaching no caller. Phase 2 opens a tenant scope per tenant from the ids
phase 1 found and does nothing but enqueue.

| Property                                    | Value                                                       |
| ------------------------------------------- | ----------------------------------------------------------- |
| Interval                                    | `WORKFLOW_SWEEP_INTERVAL_MS`, default 60 000 ms             |
| Tickets enqueued per sweep, all tenants     | `WORKFLOW_SWEEP_BATCH` = 200, oldest first                  |
| Tickets one tenant may occupy               | `WORKFLOW_SWEEP_TENANT_BATCH` = 50                          |
| Worker concurrency on the `workflows` queue | `WORKFLOW_WORKER_CONCURRENCY` = 4                           |
| Scheduler key                               | `workflow-sweep`, so a rolling deploy replaces the schedule |

Four properties carried over from the SLA sweep deliberately:

1. **The threshold lives in PostgreSQL, and Redis is treated as losable.**
   `created_at <= now() - interval` is re-asked from scratch every tick, so a Redis outage of
   any length makes escalations **late rather than absent**. A delayed job per ticket would
   be a deadline stored in Redis.
2. **Fairness is structural**, from the first commit rather than after an incident. At 50
   against a batch of 200, at least four tenants are served by every sweep.
3. **Only active tenants are probed.**
4. **Every comparison is PostgreSQL `now()`**, never a node clock.

**A ticket qualifies only while some armed elapsed workflow still has an unspent
`ticket:{id}:elapsed` claim on it.** Without that anti-join the sweep starved permanently
once a tenant held 50 long-open tickets: an unresolved ticket only gets older, so it held its
place at the head of the oldest-first sort for as long as it stayed open, and the fifty-first
ticket to cross its threshold was never enqueued at all.

**The per-workflow threshold is re-checked in the handler, before the claim.** A workflow
whose own threshold is not yet met is passed over without claiming anything — otherwise a
24-hour rule that the sweep enqueued at hour four for a 4-hour rule in the same tenant would
record `skipped` and could never fire again, because the key is spent.

**Detection can lag by up to one interval**, which is the upper bound on how late a
`ticket_unresolved_for` workflow fires. Sixty seconds against a four-hour threshold is 0.4%
of it. The interval is longer than `SLA_SWEEP_INTERVAL_MS` on purpose: an SLA breach is a
contractual deadline measured in minutes; an escalation threshold is a supervisor's own rule
with a five-minute floor.

### Loop protection

A workflow's own writes raise triggering occurrences like any other write, so three bounds
contain the loop:

1. **The dedupe key.** A workflow cannot fire twice for one occurrence, so it cannot trigger
   itself.
2. **`maxChainDepth` = 3.** A trigger raised by a workflow action carries its cause's depth
   plus one; anything else carries 0. Above the bound the job is dropped with a warning
   naming the causing run.
3. **`runsPerTicketPerHour` = 20**, counted across every workflow on that ticket.

**The run budget is asked _before_ the claim for ticket-scoped triggers.** It is a rate
limit and must not become a permanent one: checked after the claim, an over-budget run would
write `run_budget_exceeded` and spend `ticket:{id}:elapsed` for ever, so a ticket that
happened to be busy in the hour its four-hour escalation came due would record the refusal
once and never escalate. Asking first leaves the key unspent and makes the escalation late
rather than lost. Event triggers keep the failed run — their keys are per-occurrence, so
spending one costs that occurrence and nothing after it, and a supervisor still needs to find
the refusal in the run list rather than in our logs.

### Failure, and what is retried

**A claimed run that throws is written `failed` with a typed reason, and the job succeeds.**
Retrying would re-enter a claim that now conflicts, so the retry could only ever no-op; and a
tenant's malformed workflow must not fill the failed set that is monitored for infrastructure
faults.

Two things still throw, and neither is about the workflow: a database error before the
claim, and a ticket that is not visible yet. A ticket that is not visible **after** a run has
been claimed is recorded `ticket_gone` rather than retried, because the claim cannot be
re-taken.

**A stored definition that no longer parses is handled differently on the two paths, and the
asymmetry is deliberate.** The evaluator skips the workflow, because its job is not to write
to a live ticket on a definition it cannot read. The read path raises
`MalformedWorkflowDefinitionError`, which is deliberately _not_ translated to a 4xx: corrupt
automation configuration is a fault, and reporting it as a bad request would hide it.

## What a `notify` writes

One `notifications` row per recipient, with `type = 'workflow_notify'`, the workflow and run
ids in `data`, and the supervisor's `message` when there was one.

`dedupe_key` is `{workflowRunId}:{actionIndex}` against
`UNIQUE (tenant_id, recipient_user_id, dedupe_key)`. The run claim is the load-bearing
guarantee; this covers the window between that claim and these inserts, so a retry after a
partial failure re-inserts nothing. **The action index is part of the key** because a
workflow that notifies the supervisors and then notifies one of them directly must deliver
both — keyed on the run alone, the second was swallowed and reported `no_op`, which in this
vocabulary means "already in that state" rather than "we dropped your message".

## Reading and acknowledging notifications

```
GET  /api/v1/notifications                    → CursorPage<NotificationResponse>  ticket:read
POST /api/v1/notifications/{id}/acknowledge   → NotificationResponse              ticket:read
```

The generalised inbox 0009 decision 7 published, shipped by TAR-596. `GET /api/v1/sla-alerts`
and `GET /api/v1/escalation-alerts` stay exactly as published, as single-type views over the
same rows.

| Parameter            | In    | Type    | Required | Default | Notes                                                     |
| -------------------- | ----- | ------- | -------- | ------- | --------------------------------------------------------- |
| `unacknowledgedOnly` | query | boolean | no       | `true`  | The landing view is what still needs attention            |
| `type`               | query | string  | no       | —       | One of `sla_breach`, `workflow_notify`, `workflow_broken` |
| `cursor`             | query | string  | no       | —       | Keyset, on `(created_at DESC, id DESC)`                   |
| `limit`              | query | integer | no       | `25`    | 1–100                                                     |

A `NotificationResponse` carries `id`, `type`, `ticketId`, `ticketNumber`, the two
`sla_breach` fields `slaTimerId` and `dueAt`, the three flattened out of `data` — `message`,
`workflowId`, `workflowRunId` — plus `acknowledgedAt` and `createdAt`. Fields belonging to a
type other than the row's own are `null`.

**Every read is narrowed to `recipient_user_id = principal.userId`** on top of RLS, which is
why the route needs `ticket:read` rather than an `_all` permission: an agent may call it and
sees only what was addressed to them. A notification belonging to another principal answers
**404, not 403**, on 0002's rule that a 403 confirms the id exists.

The acknowledge is **idempotent**: first write wins in the `WHERE` clause, a second call
returns the same row with the original `acknowledged_at`, and nothing is a 409. It writes the
same column on the same row as `POST /api/v1/sla-alerts/{id}/acknowledge`, which is the point
of one table and one unread count.

**`escalation` rows are deliberately not in this list.** `notification_type` carries a fourth
label (TAR-468) that `NOTIFICATION_TYPES` does not, because an escalation carries
`raisedByUserId` and `reason` that `NotificationResponse` has no home for — it is read and
acknowledged through `GET/POST /api/v1/escalation-alerts` instead. Folding it in is a
contract change and belongs to whoever owns the console's unread count.

## Security and isolation

- Every request path runs through `TenantPrisma`. `workflows`, `workflow_runs` and
  `workflow_references` carry `ENABLE`/`FORCE ROW LEVEL SECURITY` and a `tenant_isolation`
  policy.
- A workflow cannot reference another tenant's tag, team or user. Ids are validated in tenant
  scope on write, and `workflow_references`' composite foreign keys are `(tenant_id, id)`, so
  a cross-tenant reference fails at the constraint even if validation were skipped. **RLS
  alone cannot hold this** — the reference row carries our own `tenant_id` and satisfies the
  policy.
- The engine holds no permission of its own; it is not an HTTP caller. The worker sets tenant
  context from `job.data.tenantId` before its first statement.
- The dry run checks `ticket:read_all` on the named ticket rather than assuming
  `workflow:write` implies it.
- A `supervisors` notify reaches exactly the population that holds `ticket:read_all`, so a
  notification exposes nothing its recipient could not already read.
- **No personal information in the job payload or in log lines.** The trigger carries ids and
  two integers. An action-failure log line names the workflow, the ticket and the failure —
  never a `notify` body or a tag name.
- The elapsed sweep's `SystemPrisma` statements are read-only, return two uuid columns and one
  aggregate, and reach no caller.

## Configuration

| Variable                     | Default | Effect                                                                |
| ---------------------------- | ------- | --------------------------------------------------------------------- |
| `WORKFLOW_SWEEP_INTERVAL_MS` | `60000` | How often the elapsed sweep runs, and the upper bound on its lateness |

Minimum 1 000 ms, coerced and validated in `apps/api/src/config/env.schema.ts`. Nothing else
about workflows is configurable: the limits are compile-time constants published through the
catalog.

**If `REDIS_URL` is unset no worker starts.** Workflows can still be written and read, and
nothing runs — the API logs that once, loudly, at boot.

## What to monitor

- `workflow.evaluate-ticket` jobs in the failed set. These are infrastructure faults by
  construction: a tenant's own malformed workflow is recorded on the run, not on the job.
- The rate of `failed` runs, by `failureReason`. A sustained `reference_missing` means
  taxonomy is being deleted out from under armed workflows.
- **`workflow.deactivated` audit rows.** Each one is a supervisor's automation that has
  silently stopped.
- `run_budget_exceeded` runs. A tenant hitting 20 runs per ticket per hour has a rule cycle
  the depth bound is only just containing.
- The elapsed sweep's batch size, logged on every run that finds work. **A full batch on
  consecutive sweeps** is the signal that 200 has stopped being enough; raise
  `WORKFLOW_SWEEP_BATCH` and `WORKFLOW_SWEEP_TENANT_BATCH` together, because raising only the
  batch makes a starving tenant wait longer rather than less.
- The deferral warning the sweep emits when a candidate is passed over — it names the
  candidate count and is emitted once per job, not once per workflow.

## Known gaps

Open at the time of writing:

- **Event triggers have no reconciler** (0009 risk 3). A `ticket_created`,
  `ticket_status_changed`, `ticket_assigned` or `ticket_sla_breached` occurrence whose enqueue
  fails during a Redis outage is logged and lost — that ticket's automation never runs, and
  nothing re-derives it. Elapsed triggers self-heal because the sweep re-asks PostgreSQL. The
  `ticket_sla_breached` case is the worst of the four: the timer is terminally `breached`, so
  there is nothing left to re-derive from.
- **`workflow_runs` is never swept.** `runsRetentionDays` is published as 90 in the catalog
  and enforced by nothing; the table grows with ticket volume × active workflows.
- **No integration spec for the workflows API**, and none for `WorkflowService` CRUD,
  `WorkflowRunService` or the sweep's SQL. The sweep's anti-join in particular is asserted by
  no test and is the most load-bearing untested statement in the module; it needs a real
  database, and `workflow-sweep.int-spec.ts` is the one to write first. Every status code and
  error code on this page is therefore read from the source and the unit suites, not from a
  request against a running stack — see [Verification](#verification).
- **No `notification.created` socket event.** 0009's realtime section publishes one; it was
  deliberately not shipped, on the reasoning that the row is already durable. A recipient
  sees a `notify` on their next read rather than immediately.

## Deviations from 0009

Five, each argued where it is made in the source:

1. **No `workflowEvaluateJobId`.** The BullMQ premise does not hold on the pinned version —
   see [Exactly once](#exactly-once-per-occurrence).
2. **The elapsed sweep skips tenants with no armed elapsed workflow**, via an `EXISTS` in the
   same statement, and takes its threshold from one fleet-wide `MIN(...)` aggregate. 0009
   writes `$1` as per-tenant while showing a single bind parameter; the global minimum is the
   reading that can only over-enqueue.
3. **The elapsed threshold is checked before the claim, not after** — otherwise a longer-
   threshold workflow spends its once-per-ticket key at the shorter workflow's tick.
4. **`brokenReason` is derived state rather than a latch.** 0009 decision 6 mechanism 3 was
   amended to this on TAR-399; the document carries the ruling and the note on what it said
   before.
5. **`GET/POST /api/v1/tags` did not come from this story.** `/api/v1/tags` exists, but from
   TAR-33's own scope rather than as 0009 pre-empts it.
   `GET /api/v1/notifications` and its acknowledge were the other half of this deviation and
   are no longer one: TAR-596 shipped them — see
   [Reading and acknowledging notifications](#reading-and-acknowledging-notifications).

## Verification

Everything below was run on 2026-08-20, against `main` at commit `a2dcb4a` (PR #154), the
commit this page was written from.

- **The condition grammar, the action executor, the claim, the chain-depth and run-budget
  bounds, and the trigger service**:
  `pnpm --filter @whatsappcrm/api exec jest src/workflows` — 4 suites, 64 tests, all passing.
- **The published grammar, the dedupe-key spellings and the catalog body**: not run here.
  `pnpm --filter @whatsappcrm/contracts test` and the console's `vitest` suites do not start
  on Node v22.15.0 — `vitest@4.1.10` resolves a `#module-evaluator` package import that this
  runtime does not define. It is an environment mismatch rather than a failure of the suite;
  those claims are read from the source instead.
- **Every route, status code, permission and error code on this page** is read from
  `apps/api/src/workflows/workflows.controller.ts`, `workflow-catalog.controller.ts`,
  `workflows.http.ts` and `workflows.errors.ts`, and every JSON body from the schemas in
  `packages/contracts/src/workflows.ts`. **There is no integration suite for this surface**,
  so unlike the assignment-rules reference these are not asserted end to end against a real
  database and the real request pipeline.
- The `curl` invocations show the request shape against a deployed host. **They were not
  run** — there is no deployed host to run them against from here.

TAR-596 added [Reading and acknowledging notifications](#reading-and-acknowledging-notifications)
and the suspension half of the reference cascade, and re-ran the following on 2026-08-22
against `main` at commit `9544f4e`:

- **The inbox's `where` clauses, its keyset page and the `data` flattening**:
  `pnpm --filter @whatsappcrm/api exec jest src/notifications` — 2 suites, 11 tests, all
  passing.
- **The suspension cascade, and that a reinstatement re-arms nothing**:
  `pnpm --filter @whatsappcrm/api exec jest src/people` — 6 suites, 64 tests, all passing.
- **The whole API suite, typecheck, lint and `nest build`**: `pnpm --filter @whatsappcrm/api
test` — 162 suites, 2 461 tests, all passing; `pnpm typecheck`, `pnpm lint` and
  `pnpm format:check` clean.
- **Still not run**: `pnpm --filter @whatsappcrm/contracts test`, for the same `vitest`
  environment mismatch recorded above, and no integration suite exists for either surface —
  the routes and status codes remain read from the source.
