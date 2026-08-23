# Assignment settings API reference

The four surfaces behind an agent's concurrent-ticket limit — the number auto-assignment
checks before it routes a ticket to somebody. Written for engineers building against the API
or the console.

Two scopes, two columns, and they are deliberately not one endpoint:

| Scope     | Column                                            | Written by                                           |
| --------- | ------------------------------------------------- | ---------------------------------------------------- |
| Workspace | `tenant_settings.default_max_concurrent_tickets`  | `PATCH /api/v1/assignment-settings`                  |
| Per agent | `users.max_concurrent_tickets` (`NULL` = inherit) | `maxConcurrentTickets` on `PATCH /api/v1/users/{id}` |

The **effective cap** is `coalesce(users.max_concurrent_tickets,
tenant_settings.default_max_concurrent_tickets)`, and the server publishes it as
`effectiveMaxConcurrentTickets` rather than leaving a client to recompute it. A client that
recomputed the coalesce would be a second implementation of a policy rule, and one of the two
would eventually disagree with the resolver that enforces it.

Request and response shapes are defined in `packages/contracts/src/assignment.ts` and
`packages/contracts/src/users.ts`, and validated at the boundary. Enforcement lives in
`apps/api/src/assignment/assignment-settings.service.ts` and
`apps/api/src/people/users.service.ts`; the two reads they share are free functions in
`apps/api/src/people/agent-capacity.ts`. The design and its trade-offs are
[0008 — assignment rotation and workload](../architecture/0008-assignment-rotation-and-workload.md),
specifically
[amendment 4](../architecture/0008-assignment-rotation-and-workload.md#amendment-4--the-cap-editing-surface-built-tar-384).

For what the cap _does_ — where it sits in eligibility, and what happens when nobody passes —
read [the auto-assignment reference](auto-assignment.md). For a supervisor raising a limit in
the console rather than calling the API, read
[Clear tickets nobody could take](../guides/clear-flagged-tickets.md).

## Conventions

| Concern           | Rule                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| Base path         | `/api/v1`                                                                       |
| Tenant            | Resolved from the request `Host`, never from a body, header or query parameter  |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                 |
| Timestamps        | ISO 8601 with an explicit offset                                                |
| Error shape       | The standard envelope, with a code from `packages/contracts/src/error-codes.ts` |
| `Idempotency-Key` | Not used here. Neither write has an external side effect                        |

**This resource is the workspace default only.** There is no per-agent roster on
`/assignment-settings`. Such a payload grows with headcount, and `GET /api/v1/users` already
pages and filters the same people — so the per-agent value is published there, on the list
that already has a ceiling.

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
| The user id is in another tenant                 | `404 not_found`       |

## Permissions

| Route                                                  | Permission                              | Held by           |
| ------------------------------------------------------ | --------------------------------------- | ----------------- |
| `GET /api/v1/assignment-settings`                      | `assignment_rule:read`                  | supervisor, admin |
| `PATCH /api/v1/assignment-settings`                    | `assignment_rule:write`                 | supervisor, admin |
| `GET /api/v1/assignment-settings/me`                   | none beyond being signed in             | every role        |
| `PATCH /api/v1/users/{id}` with `maxConcurrentTickets` | `user:update` + `assignment_rule:write` | supervisor, admin |
| Reading `assignmentCapacity` on any `UserResponse`     | `assignment_rule:read` **or** `:write`  | supervisor, admin |

**The gate is `assignment_rule:*`, never `user:update` alone.** Setting a colleague's cap to 1
is deciding how much work reaches them, which is the same act as writing a routing rule; gating
it on `user:update` would mean anyone who may edit a display name may also quietly stop work
reaching a colleague. `tenant:settings` is wrong in the other direction — admin-only, and
tuning workload is a supervisor's daily job. The matrix is
[0004 — RBAC permission matrix](../architecture/0004-rbac-permission-matrix.md); the argument is
0008 decision 4.

**The `assignmentCapacity` gate is `read` OR `write`, not `read` alone.** A role granted write
without read would otherwise set a value and be handed `null` back.

## `GET /api/v1/assignment-settings`

The workspace-wide default cap.

**Authentication.** Session cookie, `assignment_rule:read`. Without it, `403 forbidden`.

No parameters.

```bash
curl -b cookies.txt https://acme.app.example.com/api/v1/assignment-settings
```

```json
{ "defaultMaxConcurrentTickets": 5, "updatedAt": "2026-08-12T08:28:59.681Z" }
```

| Status | Code              | Cause                               |
| ------ | ----------------- | ----------------------------------- |
| `200`  | —                 |                                     |
| `401`  | `unauthenticated` | No usable session                   |
| `403`  | `forbidden`       | Caller lacks `assignment_rule:read` |

**A workspace with no `tenant_settings` row is answered `200`, not `404`.** It gets
`defaultMaxConcurrentTickets: 5` — `ASSIGNMENT_POLICY.defaultMaxConcurrentTickets`, the
built-in the rotation resolver coalesces to — and `updatedAt: null`. That workspace has a
working effective default, and a `404` would claim otherwise. Provisioning writes the row for
every workspace it creates, so this branch is for workspaces that predate it.

⚠️ **`updatedAt` is not a "has anybody configured this" signal.** It is when the settings _row_
was last written, and that row also carries `timezone`, `locale` and `businessHours` — any of
which moves the timestamp without touching the cap. Provisioning writes the row without
choosing a cap, so a non-null timestamp can sit on a value nobody picked. The question "was
this cap ever set deliberately" is answered by the `assignment_settings.updated` audit trail,
which records exactly that. `null` means only that no settings row exists at all.

## `PATCH /api/v1/assignment-settings`

Move the workspace-wide default.

**Authentication.** Session cookie, `assignment_rule:write`. Without it, `403 forbidden` and
nothing is written.

**Idempotency.** Replaying the same body writes the same value and appends a second audit row.
Last write wins — there is no `If-Match` and no version field. Two supervisors editing one
integer seconds apart is not a scenario worth a concurrency protocol, and the trail records
both.

| Parameter                     | In   | Type | Required | Default | Notes                      |
| ----------------------------- | ---- | ---- | -------- | ------- | -------------------------- |
| `defaultMaxConcurrentTickets` | body | int  | yes      | —       | 1–1000, whole numbers only |

```bash
curl -X PATCH -b cookies.txt \
  -H 'content-type: application/json' \
  -d '{"defaultMaxConcurrentTickets":8}' \
  https://acme.app.example.com/api/v1/assignment-settings
```

```json
{ "defaultMaxConcurrentTickets": 8, "updatedAt": "2026-08-23T09:14:02.117Z" }
```

| Status | Code                | Cause                                                            |
| ------ | ------------------- | ---------------------------------------------------------------- |
| `200`  | —                   |                                                                  |
| `400`  | `validation_failed` | Out of 1–1000, not an integer, wrong JSON type, or an empty body |
| `401`  | `unauthenticated`   | No usable session                                                |
| `403`  | `forbidden`         | Caller lacks `assignment_rule:write`                             |

**It upserts**, so the missing-row case above is not a second failure path: the first
supervisor to set a cap on a legacy workspace creates the row rather than being told there is
nothing to patch.

**An empty body is `400`, not a `200` no-op.** The resource has exactly one writable value
today, so `{}` can only be a client mistake; it answers `validation_failed` naming
`defaultMaxConcurrentTickets`. When a second field lands, this becomes a partial update with an
at-least-one rule.

**Both bounds are the `CHECK` constraints** `tenant_settings_default_max_concurrent_tickets_range`
and `users_max_concurrent_tickets_range` in migration
`20260813140000_assignment_workload_and_routing_state`, and the constants
`ASSIGNMENT_POLICY.minMaxConcurrentTickets` / `.maxMaxConcurrentTickets`. The floor is 1 rather
than 0 because "route nothing to me" is what `availability: 'away'` already means, and a second
way to say it is a second thing to keep in step.

## `GET /api/v1/assignment-settings/me`

The caller's own cap and current load.

**Authentication.** Session cookie. No permission beyond being signed in — the resource _is_
the caller.

No parameters, and it takes no id. "Own value only" is the shape of the query rather than a
check somebody has to remember.

```bash
curl -b cookies.txt https://acme.app.example.com/api/v1/assignment-settings/me
```

```json
{
  "maxConcurrentTickets": 3,
  "effectiveMaxConcurrentTickets": 3,
  "activeTicketCount": 1,
  "defaultMaxConcurrentTickets": 5
}
```

| Field                           | Type          | Notes                                                        |
| ------------------------------- | ------------- | ------------------------------------------------------------ |
| `maxConcurrentTickets`          | int \| `null` | The caller's own override. `null` = inherits the default     |
| `effectiveMaxConcurrentTickets` | int           | The number rotation actually compares against                |
| `activeTicketCount`             | int           | Assigned tickets in `open` or `pending`                      |
| `defaultMaxConcurrentTickets`   | int           | The workspace default, so a console can render "5 (default)" |

| Status | Code              | Cause             |
| ------ | ----------------- | ----------------- |
| `200`  | —                 |                   |
| `401`  | `unauthenticated` | No usable session |

**There is no write counterpart, and the absence is the point.** An agent may see the cap being
applied to them and may not lift it — `PATCH /api/v1/assignment-settings/me` is `404`, because
no such route exists.

⚠️ **This route shipped with no console screen behind it** (TAR-384). It is built, gated and
covered by integration tests, and nothing in the product calls it today; the parent story's
assumption was that an agent may view their own limit, but no acceptance criterion asked for a
place to view it. Treat it as a stable API with no UI, not as an unfinished one.

**`atCapacity` is deliberately not a field.** It is
`activeTicketCount >= effectiveMaxConcurrentTickets`, a comparison the client can do, and a
derived boolean is one more thing to keep in step.

## The per-agent override

Written through `PATCH /api/v1/users/{id}` and read through `GET /api/v1/users` — the resource
that owns the column. Both are documented in full in
[the people and teams API reference](people-api.md); what follows is only what the cap adds.

### Writing it

`maxConcurrentTickets` on the `PATCH /api/v1/users/{id}` body: an integer in 1–1000, or `null`.

**`null` and omitted are different, and a handler must not collapse them.** `null` clears the
override and returns the agent to the workspace default; omitting the field leaves whatever is
there alone.

```bash
curl -X PATCH -b cookies.txt \
  -H 'content-type: application/json' \
  -d '{"maxConcurrentTickets":8}' \
  https://acme.app.example.com/api/v1/users/019fee01-8b3d-7c41-a2e6-5d90f4c17b28
```

**A body carrying this field from a caller without `assignment_rule:write` is refused, never
stripped** — the rule TAR-79 established for `role`. A privilege-shaped change that appears to
have succeeded is the worse of the two failures.

```json
{
  "error": {
    "code": "forbidden",
    "message": "Changing an agent’s maximum concurrent tickets requires the assignment_rule:write permission, which is held by supervisors and admins. You can change this person’s name, status and teams.",
    "requestId": "4ce80ce1-778b-49a7-8ad9-2bc98aa8eaff"
  }
}
```

**That check runs after the row is resolved**, so a caller without the permission patching an id
that does not exist gets `404 not_found`, not `403`. A `403` on an unknown id is an existence
oracle. The full order inside `UsersService.update` is **validate → resolve the row (404) →
permission-on-field (403) → invariants (409) → write**.

**A user in another tenant is `404`, never `403`**, for the same reason: row-level security
makes absent and invisible indistinguishable, which is the intent.

### Reading it

`assignmentCapacity` on every `UserResponse` — so on `GET /api/v1/users`, and on the response to
every write path that returns a user.

```json
{
  "maxConcurrentTickets": 4,
  "effectiveMaxConcurrentTickets": 4,
  "activeTicketCount": 2
}
```

It is **`null` for a caller holding neither `assignment_rule:read` nor `:write`** — which is
every agent. `GET /api/v1/users` is `user:read`, held by every role, so an ungated cap field
there would give anyone in the workspace a live readout of a named colleague's workload and how
close they are to being cut off from work. The gate is in the mapper rather than the handler, so
a future endpoint returning a `UserResponse` cannot leak it by forgetting to.

`activeTicketCount` costs **one aggregate per page, not one query per user**: a
`GROUP BY assigned_user_id` over the page's ids, served by
`tickets_tenant_assigned_user_queue_idx`, bounded by the list's `limit` of at most 100. It is
skipped entirely for a caller who would get `null`, so an agent's people list pays nothing.

## When a change takes effect

**On the next assignment, with no restart and no cache to clear.**
`RotationFallbackResolver.readCandidates` computes the coalesce in one raw statement per routing
job, and nothing memoises either column. This is the parent story's third acceptance criterion,
and it holds because nothing was added — so the way to break it is to add a cache.

Three consequences worth stating, because all three look like bugs otherwise:

- **A ticket already deferred is not re-routed.** Raising a cap frees the agent for the _next_
  ticket rotation places; the flagged one waits for a person to assign it. Nothing retries a
  deferred ticket when capacity frees up.
- **Lowering a cap below an agent's current load is allowed and takes no ticket off them.** They
  are skipped by rotation until they close down to the new number.
- **The cap is exact only at assignment-worker concurrency 1.** Raising that concurrency, or
  running two API processes, makes it approximate — two workers can both see an agent at
  `cap − 1` and both assign. Unchanged by this surface; the reasoning is in 0008.

## Audit

Both writes are audited, on the `assignment_rule.*` precedent — this is a permissioned,
privilege-shaped field rather than an ordinary one.

| Action                        | `targetType`      | `targetId`  | `metadata`                      |
| ----------------------------- | ----------------- | ----------- | ------------------------------- |
| `assignment_settings.updated` | `tenant_settings` | The tenant  | `{ from, to }`, `from` nullable |
| `user.capacity_changed`       | `user`            | The user id | `{ from, to }`, both nullable   |

`assignment_settings.updated` is written **even when the number is unchanged**: the row may not
have existed at all, and "this workspace's default was chosen deliberately" is the question the
trail exists to answer — suppressing a no-op would lose the first deliberate choice that
happened to match the built-in 5. `from: null` means there was no settings row, which is not the
same fact as somebody having set that number. The per-user path is the opposite and skips a
write when `from === to`, where an unchanged value means somebody re-sent a form.

**Neither write revokes a session.** A cap change alters what work reaches somebody, not what
they may do.

## Tenant isolation

Every read and write goes through `TenantPrisma` under row-level security, and there is no
tenant parameter anywhere in this surface. Two workspaces' defaults stay apart, another
workspace's user id answers `not_found`, and only the calling workspace's tickets count toward a
load — all four asserted in `apps/api/src/assignment/assignment-settings.int-spec.ts`.

The payloads carry ids, integers and one timestamp. No PII.

## Verification

`apps/api/src/assignment/assignment-settings.int-spec.ts` exercises this surface end to end
against a real database: the missing-row fallback, the upsert-on-first-write, the audit trail,
the bounds, the empty body, every permission refusal, the agent's own read, the absent write
counterpart, the gated field on `GET /users`, and the four tenant-isolation cases. Every example
on this page was read from that spec or from the handlers it drives.

**The examples were not executed against a running stack.** Bodies, status codes and error
copy are transcribed from the integration spec, the Zod schemas in
`packages/contracts/src/`, and the service that raises each error; hosts and ids are
placeholders. Where this page and the code ever disagree, the code is right — say so on
TAR-761.
