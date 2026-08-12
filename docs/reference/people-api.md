# People and teams API reference

The tenant-facing routes for managing agents, teams and roles: `/api/v1/users` and
`/api/v1/teams`. Written for engineers building against the API or the console.

This is the surface a tenant's own admins and supervisors use. It is not the platform
admin surface — `/api/v1/admin/*` is operated by us, authenticates on a bearer token, and
is documented in [`admin-api.md`](admin-api.md).

Request and response shapes are defined in `packages/contracts/src/users.ts` and
`packages/contracts/src/rbac.ts` and validated at the boundary. Enforcement lives in
`apps/api/src/people/` and `apps/api/src/rbac/`. The permission matrix itself, and the
reasoning behind every grant in it, is
[ADR 0004](../architecture/0004-rbac-permission-matrix.md) — this page documents the HTTP
surface, not the policy. Every example below was executed against a local stack built from
`main`; see [Verification](#verification).

**Invitations are not on this page.** Creating an account is
`POST /api/v1/users/invites` and its siblings, owned by `IdentityModule` against
[ADR 0005](../architecture/0005-auth-session-and-invite-contract.md). An invitation is a
credential with its own lifecycle rather than a person, and it is summarised under
[Invitations](../../README.md#invitations) in the README. The routes here manage people who
already exist.

## Conventions

| Concern           | Rule                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- |
| Base path         | `/api/v1`                                                                              |
| Tenant            | Resolved from the request `Host`, never from a body, header or query parameter         |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                        |
| Lists             | `{ items, nextCursor }`. Keyset paginated, `limit` 1–100, default 25                   |
| Timestamps        | ISO 8601 with an explicit offset                                                       |
| Error shape       | The standard envelope, with a code from `packages/contracts/src/error-codes.ts`        |
| `Idempotency-Key` | Not used here. `DELETE` is idempotent by design; the rest are ordinary reads or writes |

## Authentication

Every route requires a signed-in user. The caller presents the session cookie
`wac_session` — `__Host-wac_session` wherever `SESSION_COOKIE_SECURE` is on, which is
everywhere except plain-HTTP local development — and the API resolves it against the
tenant the request host resolved to.

Three guards run on every route in the application, in this order, before any handler:
**where** the request is (`HostTenantGuard`), **who** is making it (`PrincipalGuard`), then
**may they** (`PermissionGuard`). None of the controllers on this page declares them; since
TAR-58 the pipeline is global, so a route added later is closed by default rather than open
by omission.

| Condition                                        | Answer                |
| ------------------------------------------------ | --------------------- |
| No cookie, or an expired, revoked or unknown one | `401 unauthenticated` |
| A valid session belonging to a different tenant  | `401 tenant_mismatch` |
| Signed in, but the role lacks the permission     | `403 forbidden`       |
| The record is in another tenant                  | `404 not_found`       |

The last two are the distinction worth holding on to. `forbidden` is only ever returned for
something the caller can already see — a colleague's row they may read but not promote. A
record belonging to another tenant is `not_found`, because a 403 would confirm the id
exists somewhere.

## Roles and the permissions that matter here

Three tenant roles ship: `agent`, `supervisor` and `admin`. A role is a bundle;
`ROLE_PERMISSIONS` in `packages/contracts/src/rbac.ts` is the only place one is ever
interpreted, and guards ask for permissions rather than roles.

| Role         | Permissions in total | On this surface                                              |
| ------------ | -------------------- | ------------------------------------------------------------ |
| `agent`      | 13                   | `user:read`, `team:read`                                     |
| `supervisor` | 26                   | the agent's, plus `user:invite`, `user:update`, `team:write` |
| `admin`      | 38                   | the supervisor's, plus `user:set_role` and `user:remove`     |

Two splits in that table carry the security of the whole surface:

- **`user:set_role` is separate from `user:update`.** Without the split a supervisor
  holding `user:update` could promote themselves, and one holding `user:invite` could mint
  an admin — privilege escalation with no second person involved. So a supervisor may
  change a person's name, status and teams, and may not touch their role.
- **`user:remove` stays admin-only.** Removal is irreversible and changes seat billing,
  while `status: "suspended"` covers "cut their access now" and is one click back.

### Route summary

| Route                                  | Permission                      | Held by           |
| -------------------------------------- | ------------------------------- | ----------------- |
| `GET /api/v1/users`                    | `user:read`                     | every role        |
| `PATCH /api/v1/users/me/availability`  | none beyond being signed in     | every role        |
| `PATCH /api/v1/users/{id}`             | `user:update`                   | supervisor, admin |
| `PATCH /api/v1/users/{id}` with `role` | `user:update` + `user:set_role` | admin             |
| `POST /api/v1/users/{id}/unlock`       | `user:update`                   | supervisor, admin |
| `DELETE /api/v1/users/{id}`            | `user:remove`                   | admin             |
| `GET /api/v1/teams`                    | `team:read`                     | every role        |
| `POST /api/v1/teams`                   | `team:write`                    | supervisor, admin |
| `PATCH /api/v1/teams/{id}`             | `team:write`                    | supervisor, admin |

`GET /api/v1/users` is tenant-wide for every role, `agent` included: the console cannot
render an assignee name, a "routed to" label or a mention without it. It exposes who works
here, not what they can see — conversation visibility is a separate rule, described in
[What a team actually does](#what-a-team-actually-does).

## `GET /api/v1/users`

The people list, tenant-wide. Keyset paginated on `id` descending, which is a UUIDv7 and
therefore already in creation order.

| Parameter | In    | Type   | Required | Default | Notes                                                               |
| --------- | ----- | ------ | -------- | ------- | ------------------------------------------------------------------- |
| `cursor`  | query | string | no       | —       | The `nextCursor` from the previous page                             |
| `limit`   | query | int    | no       | `25`    | 1–100                                                               |
| `role`    | query | enum   | no       | —       | `agent` \| `supervisor` \| `admin`                                  |
| `status`  | query | enum   | no       | —       | `invited` \| `active` \| `suspended` \| `removed`                   |
| `teamId`  | query | uuid   | no       | —       | Members of one team                                                 |
| `q`       | query | string | no       | —       | 1–120 characters. Matches display name or email, case-insensitively |

```bash
curl -b cookies.txt 'http://northwind.app.localhost:3051/api/v1/users?limit=3'
```

```json
{
  "items": [
    {
      "id": "0192f001-0000-7000-8000-000000000104",
      "email": "liang@northwind.example",
      "displayName": "Liang Wei",
      "avatarUrl": null,
      "role": "agent",
      "status": "active",
      "availability": "offline",
      "teamIds": ["0192f002-0000-7000-8000-000000000202"],
      "occupiesSeat": true,
      "lastSeenAt": "2026-08-10T08:30:59.681Z",
      "security": { "lockedUntil": null, "failedLoginAttempts": 0 },
      "createdAt": "2026-07-03T08:30:59.681Z"
    }
  ],
  "nextCursor": "0192f001-0000-7000-8000-000000000103"
}
```

`nextCursor` is `null` on the last page.

Two fields behave in ways the shape does not show:

- **`security` is `null` for a caller without `user:update`.** Every agent holds
  `user:read`, so flat lockout fields would give anyone in the tenant a live readout of how
  close a named colleague is to being locked out, and confirmation when it lands. It is
  omitted by the mapper rather than by the handler, so a new endpoint returning a
  `UserResponse` cannot leak it by forgetting to. For a caller who _does_ hold the
  permission it is never `null` — an admin reading `null` could not tell "not locked" from
  "not allowed to know".
- **`removed` accounts are absent unless asked for by name.** With no `status` filter the
  list excludes them; `?status=removed` returns them. A soft delete that still appears in a
  people list, an assignee picker or a mention menu is a soft delete nobody trusts.

| Status | Code                | Cause                                                     |
| ------ | ------------------- | --------------------------------------------------------- |
| `200`  | —                   |                                                           |
| `400`  | `validation_failed` | `limit` out of range, or a filter that is not in its enum |
| `401`  | `unauthenticated`   | No usable session                                         |
| `403`  | `forbidden`         | Caller lacks `user:read`. No shipped role is in this case |

## `PATCH /api/v1/users/me/availability`

Sets the caller's own availability. Availability drives auto-assignment: an `away` or
`offline` agent is skipped by round-robin.

Requires no permission beyond a session — the resource _is_ the caller — and that is
declared out loud with `@AnyPrincipal()` rather than left implicit, because
`PermissionGuard` refuses a route carrying no metadata at all.

There is deliberately no route for setting somebody else's. Setting a colleague to `away`
would be a way to route work off them; a supervisor who wants that changes their status or
their teams, both of which are audited.

| Parameter      | In   | Type | Required | Default | Notes                              |
| -------------- | ---- | ---- | -------- | ------- | ---------------------------------- |
| `availability` | body | enum | yes      | —       | `available` \| `away` \| `offline` |

```bash
curl -X PATCH -b cookies.txt \
  -H 'content-type: application/json' \
  -d '{"availability":"available"}' \
  http://northwind.app.localhost:3051/api/v1/users/me/availability
```

Answers `200` with the caller's full `UserResponse`.

## `PATCH /api/v1/users/{id}`

Changes a person's display name, role, status or team membership.

**The route needs `user:update`; a body carrying `role` additionally needs
`user:set_role`.** A caller without it is refused rather than served with the field quietly
dropped — a privilege change that appears to have succeeded is the worse of the two
failures. That second check is in the service rather than the guard because the guard's
metadata is static and this condition is not.

| Parameter     | In   | Type   | Required | Default | Notes                                                                          |
| ------------- | ---- | ------ | -------- | ------- | ------------------------------------------------------------------------------ |
| `id`          | path | uuid   | yes      | —       | A malformed id is `validation_failed`, not a database error                    |
| `displayName` | body | string | no       | —       | 1–120 characters                                                               |
| `role`        | body | enum   | no       | —       | `agent` \| `supervisor` \| `admin`. Additionally requires `user:set_role`      |
| `status`      | body | enum   | no       | —       | `active` \| `suspended` **only**                                               |
| `teamIds`     | body | uuid[] | no       | —       | Replaces the whole membership. Omitting it leaves membership alone. At most 50 |

`status` is narrower than the `user_status` column on purpose. `invited` is written by the
invite flow and cleared by acceptance, and `removed` is written by `DELETE`, which is gated
on admin-only `user:remove` — allowing either here would let a supervisor remove an account
through the side door.

`teamIds` is the whole membership, not a delta. A client sends the membership it wants
rather than a delta it computed against a list it may have read minutes ago.

```bash
curl -X PATCH -b cookies.txt \
  -H 'content-type: application/json' \
  -d '{"role":"supervisor","teamIds":["0192f002-0000-7000-8000-000000000201"]}' \
  http://northwind.app.localhost:3051/api/v1/users/0192f001-0000-7000-8000-000000000101
```

```json
{
  "id": "0192f001-0000-7000-8000-000000000101",
  "email": "amina@northwind.example",
  "displayName": "Amina Haddad",
  "avatarUrl": null,
  "role": "supervisor",
  "status": "active",
  "availability": "available",
  "teamIds": ["0192f002-0000-7000-8000-000000000201"],
  "occupiesSeat": true,
  "lastSeenAt": "2026-08-12T08:28:59.681Z",
  "security": { "lockedUntil": null, "failedLoginAttempts": 0 },
  "createdAt": "2026-06-15T08:30:59.681Z"
}
```

| Status | Code                  | Cause                                                                                                                               |
| ------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | —                     |                                                                                                                                     |
| `400`  | `validation_failed`   | A field failed its schema, or `teamIds` names a team that is not in this tenant                                                     |
| `401`  | `unauthenticated`     | No usable session                                                                                                                   |
| `403`  | `forbidden`           | No `user:update`; or `role` was sent without `user:set_role`; or it is the caller's own role; or the role is above the caller's own |
| `404`  | `not_found`           | No such user in this tenant                                                                                                         |
| `409`  | `last_admin_required` | The change would leave the tenant with no active admin                                                                              |

The three `403`s carry different messages, because the reasons are genuinely different:

```json
{
  "error": {
    "code": "forbidden",
    "message": "Assigning the admin role requires the user:set_role permission, which is held by admins only. You can invite an agent, and change a person’s name, status and teams.",
    "requestId": "4ce80ce1-778b-49a7-8ad9-2bc98aa8eaff"
  }
}
```

```json
{
  "error": {
    "code": "forbidden",
    "message": "You cannot change your own role. Ask another admin to do it.",
    "requestId": "d3db171d-8343-4c37-b7e4-fc29edf9c82e"
  }
}
```

## `POST /api/v1/users/{id}/unlock`

Clears a brute-force lockout. `user:update` — the same permission that reveals `security`
on a `UserResponse`, so whoever may see that somebody is locked out is whoever may let them
back in.

Takes no body. Answers `200` with the user's post-state rather than `204`, because the
caller wants the cleared state back to render. Idempotent, so a double-click is harmless,
and audited only when it actually cleared something.

It clears both counters that can refuse the account — the durable columns and the Redis
lockout keyed by the address. Leaving the second would make "let them back in now" mean "in
up to fifteen minutes". It does not revoke sessions and does not touch the password: an
account is locked because somebody was guessing, which says nothing about whether the
credential is still good.

```bash
curl -X POST -b cookies.txt \
  http://northwind.app.localhost:3051/api/v1/users/0192f001-0000-7000-8000-000000000104/unlock
```

| Status | Code              | Cause                             |
| ------ | ----------------- | --------------------------------- |
| `200`  | —                 | Including when nothing was locked |
| `401`  | `unauthenticated` | No usable session                 |
| `403`  | `forbidden`       | Caller lacks `user:update`        |
| `404`  | `not_found`       | No such user in this tenant       |

## `DELETE /api/v1/users/{id}`

Removes a person: `status: "removed"`, every session killed, every team left, every routing
reference cleared, any outstanding invitation revoked. Admin-only, audited, idempotent, and
answers `204`.

**It is a status change, not a `DELETE FROM users`,** and that is the one design decision
here worth knowing before you call it. Four tables reference `users` as _history_ —
`messages.sender_user_id`, `internal_notes`, `ticket_events` and `audit_logs.actor_user_id`.
A hard delete has to null those too, which is deletion quietly rewriting the record of what
happened, including the record a SOC 2 style review asks for. So the account is gone from
every screen — delisted, logged out, unassignable, not occupying a seat — while what they
did stays attributable. A tenant that needs the row itself erased is a data-subject erasure
request, which is a different operation with a different legal shape.

What it clears, so nothing is left pointing at somebody who is gone:

| Table               | Effect                                               |
| ------------------- | ---------------------------------------------------- |
| `conversations`     | `assigned_user_id` set to null                       |
| `tickets`           | `assigned_user_id` set to null                       |
| `assignment_states` | `last_assigned_user_id` set to null                  |
| `assignment_rules`  | `target_user_id` nulled **and** the rule deactivated |
| `team_members`      | Rows deleted                                         |
| `invites`           | Any live invitation for that address revoked         |
| `sessions`          | Revoked, reason `removed`                            |

An assignment rule is deactivated rather than deleted so a supervisor finds the rule needing
a new target instead of finding it silently gone. Revoking the invitation matters more than
it looks: without it, removing somebody who had been invited but never accepted would leave
their emailed link live, and redeeming it would reinstate the account.

| Status | Code                  | Cause                                                     |
| ------ | --------------------- | --------------------------------------------------------- |
| `204`  | —                     | Including a repeat call on somebody already removed       |
| `401`  | `unauthenticated`     | No usable session                                         |
| `403`  | `forbidden`           | Caller lacks `user:remove` — a supervisor is in this case |
| `404`  | `not_found`           | No such user in this tenant                               |
| `409`  | `last_admin_required` | The target is the last active admin                       |

> **TODO(author):** `UserHasHistoryError` in `apps/api/src/people/people.errors.ts` is
> mapped to `conflict` by `translatePeopleFailure` but is never thrown — the soft-delete
> design made it unreachable. Either it is dead code to remove, or a case the removal path
> is meant to refuse and does not. Raised for TAR-84.

## `GET /api/v1/teams`

Lists teams. `team:read`, held by every role, because an agent has to see the team names on
their own conversations.

Keyset paginated on `id` **ascending**, unlike the people list: teams are a small, stable
set that a picker renders whole, and newest-first would reshuffle the dropdown every time
somebody adds one.

| Parameter | In    | Type   | Required | Default | Notes                                   |
| --------- | ----- | ------ | -------- | ------- | --------------------------------------- |
| `cursor`  | query | string | no       | —       | The `nextCursor` from the previous page |
| `limit`   | query | int    | no       | `25`    | 1–100                                   |
| `q`       | query | string | no       | —       | 1–80 characters. Matches the name       |

```json
{
  "items": [
    {
      "id": "0192f002-0000-7000-8000-000000000201",
      "name": "Billing",
      "description": "Payment, invoice and refund questions.",
      "memberUserIds": [
        "0192f001-0000-7000-8000-000000000101",
        "0192f001-0000-7000-8000-000000000102"
      ],
      "createdAt": "2026-06-16T08:30:59.681Z"
    }
  ],
  "nextCursor": null
}
```

Name matching is case-insensitive without a `mode` flag, because `teams.name` is `citext`.

## `POST /api/v1/teams`

Creates a team. `team:write` — supervisor and admin.

| Parameter       | In   | Type           | Required | Default | Notes                                                  |
| --------------- | ---- | -------------- | -------- | ------- | ------------------------------------------------------ |
| `name`          | body | string         | yes      | —       | 1–80 characters. Unique per tenant, case-insensitively |
| `description`   | body | string \| null | no       | `null`  | Up to 500 characters                                   |
| `memberUserIds` | body | uuid[]         | no       | `[]`    | Must all be users in this tenant. At most 500          |

```bash
curl -X POST -b cookies.txt \
  -H 'content-type: application/json' \
  -d '{"name":"Retention","description":"Win-back and churn saves.","memberUserIds":["0192f001-0000-7000-8000-000000000101"]}' \
  http://northwind.app.localhost:3051/api/v1/teams
```

`201 Created`:

```json
{
  "id": "019ff519-e999-7229-9ece-0ba3d63b14cb",
  "name": "Retention",
  "description": "Win-back and churn saves.",
  "memberUserIds": ["0192f001-0000-7000-8000-000000000101"],
  "createdAt": "2026-08-12T08:32:23.961Z"
}
```

| Status | Code                | Cause                                                        |
| ------ | ------------------- | ------------------------------------------------------------ |
| `201`  | —                   |                                                              |
| `400`  | `validation_failed` | A field failed its schema, or a member is not in this tenant |
| `401`  | `unauthenticated`   | No usable session                                            |
| `403`  | `forbidden`         | Caller lacks `team:write` — an agent is in this case         |
| `409`  | `conflict`          | A team with that name already exists in this tenant          |

Names collide case-insensitively, and the message says so, because "Billing already exists"
is confusing when you typed "billing":

```json
{
  "error": {
    "code": "conflict",
    "message": "A team named retention already exists in this tenant. Team names are case-insensitive.",
    "requestId": "1daa6ef9-5a9e-47ad-8bbf-82ab10b58948"
  }
}
```

Without case-insensitivity a tenant ends up with two teams that are indistinguishable in
every picker while holding different conversations.

## `PATCH /api/v1/teams/{id}`

Renames a team, re-describes it, or replaces its membership. `team:write`.

This route is **not** in the endpoint surface published by TAR-39, which listed only `GET`
and `POST /teams` while exporting a `TeamUpdateInputSchema`. It was added because a
supervisor asked to manage teams could otherwise create one and never change who is in it —
the only other way to move somebody between teams is `PATCH /users/{id}`, which needs
`user:update`. Additive, so no existing client breaks.

| Parameter       | In   | Type           | Required | Default | Notes                                                                 |
| --------------- | ---- | -------------- | -------- | ------- | --------------------------------------------------------------------- |
| `id`            | path | uuid           | yes      | —       |                                                                       |
| `name`          | body | string         | no       | —       | 1–80 characters                                                       |
| `description`   | body | string \| null | no       | —       | Up to 500 characters                                                  |
| `memberUserIds` | body | uuid[]         | no       | —       | **Replaces** the membership. Omitting it leaves it alone. At most 500 |

Every field is optional; `memberUserIds` replaces rather than merges, for the same reason
`teamIds` does on a user.

Both membership arrays are capped — 500 members on a team, 50 teams on a person — because
the work behind each id is per-id: every affected person's sessions are revoked and their
principal cache purged. The cap is on the request, and it is what keeps one call's fan-out
off a connection pool the whole tenant shares (TAR-244). A team may still grow past 500 one
person at a time through `PATCH /users/{id}`, which bounds the other side of the relation.

| Status | Code                | Cause                                                        |
| ------ | ------------------- | ------------------------------------------------------------ |
| `200`  | —                   |                                                              |
| `400`  | `validation_failed` | A field failed its schema, or a member is not in this tenant |
| `401`  | `unauthenticated`   | No usable session                                            |
| `403`  | `forbidden`         | Caller lacks `team:write`                                    |
| `404`  | `not_found`         | No such team in this tenant                                  |
| `409`  | `conflict`          | The new name is taken                                        |

There is no `DELETE /api/v1/teams/{id}`. A team is a routing target referenced by
conversations, tickets and assignment rules, and nothing has yet decided what happens to
those when it disappears.

> **TODO(author):** Is team deletion (or deactivation) planned, and under which story?
> Documented here as absent rather than left for a reader to discover from a 404.

## The invariants

Permissions answer "may this caller perform this operation at all". They cannot express
rules about the _target_ or the _resulting state_, so four of those are enforced in the
service layer and each has its own message.

| #   | Rule                                                          | Answer                    |
| --- | ------------------------------------------------------------- | ------------------------- |
| 1   | Nobody changes their own role, admins included                | `403 forbidden`           |
| 2   | Nobody grants a role above their own                          | `403 forbidden`           |
| 3   | The last active admin cannot be demoted, suspended or removed | `409 last_admin_required` |
| 4   | Removing somebody clears every routing reference to them      | part of `204`             |

Invariant 1 means every escalation needs a second person, and it removes the commonest
self-lockout — an admin demoting themselves. Invariant 2 is stated as an ordering
(`ROLE_SENIORITY`) rather than discovered later: under the current matrix only an admin
holds `user:set_role` and admin is the top, so it is already implied, but adding a fourth
role between supervisor and admin must not silently open a path.

Invariant 3 is a locking read (`SELECT … FOR UPDATE` over the tenant's active admins), not
a `count()`. Two concurrent demotions of two different admins would each otherwise read
"one other admin exists" and both commit, leaving zero — and a tenant with no admin cannot
manage billing, branding or its WhatsApp credentials, and can only be recovered by platform
support.

```json
{
  "error": {
    "code": "last_admin_required",
    "message": "This is the last active admin in the tenant. Promote another admin first — a tenant with no admin cannot manage billing, branding or its WhatsApp credentials.",
    "requestId": "b32fbd5a-e967-4c76-b133-f6cc0ee1e516"
  }
}
```

## What a team actually does

A team is two things at once, and the second is why membership changes are not an ordinary
update:

- **A routing target.** Conversations and tickets carry `assigned_team_id`.
- **A visibility boundary.** A record assigned to a team is visible to every member and to
  nobody else without the matching `_all` permission.

The rule, in `apps/api/src/rbac/visibility.ts` and written once so no second copy can
drift:

```text
holds `<resource>:read_all`   → every record in the tenant
assigned to me                → visible
assigned to a team I am in    → visible
otherwise                     → not visible
```

Conversations widen that by one branch: an **unclaimed** conversation — no assignee and no
team — is visible to every agent in the tenant, because a conversation is created by a
customer writing in, and a message nobody can see is not an isolation property but an
unanswered customer. Visible is not writable: replying to one requires claiming it first.
Tickets do not widen, because their backlog is work somebody has already triaged.

## Side effects of a change

### Sessions are revoked, in the same transaction

`SessionPrincipal` carries `permissions` and `teamIds` materialised at resolution time, so
any change to a person's role, status or team membership leaves an active session
describing somebody who no longer exists. Every such mutation therefore revokes that user's
sessions in the same transaction, and purges the principal cache again after the commit —
the in-transaction purge alone can be repopulated by a concurrent request reading the
still-unrevoked row.

| Change                            | Sessions revoked                        | Reason recorded |
| --------------------------------- | --------------------------------------- | --------------- |
| Role changed                      | the target's                            | `role_change`   |
| Status changed                    | the target's                            | `status_change` |
| `teamIds` changed on a user       | the target's                            | `teams_change`  |
| `memberUserIds` changed on a team | everyone added **and** everyone removed | `teams_change`  |
| User removed                      | the target's                            | `removed`       |
| Name changed only, or an unlock   | none                                    | —               |

Both directions on a team matter: a new member gains a scope they did not have, and a
removed one keeps theirs until their session dies. The practical consequence for a client
is that **the affected person's next request is a 401**, not their next login — verified
below.

### One audit row per thing that actually changed

| Action                 | Written when                              |
| ---------------------- | ----------------------------------------- |
| `user.role_changed`    | `role` differs from the stored value      |
| `user.status_changed`  | `status` differs                          |
| `user.profile_changed` | `displayName` differs                     |
| `user.teams_changed`   | membership actually moved                 |
| `user.removed`         | a `DELETE` that was not already removed   |
| `team.created`         | `POST /teams`                             |
| `team.updated`         | `PATCH /teams/{id}`                       |
| `session.revoked`      | alongside any of the above that revoked   |
| `auth.unlock`          | an unlock that actually cleared something |

Sending a field with the value it already holds writes nothing. Rows carry
`actor_type = 'user'` and the acting `actor_user_id`.

## Tenant isolation

Every statement on this surface runs on `TenantPrisma`, which sets the `app.tenant_id` GUC
that row-level security reads. No service here takes a tenant id as a parameter, so "no
cross-tenant read or write under any role" is a property of the wiring rather than of
remembering a filter.

Row-level security is not the whole story for team membership: a row that carries the
caller's own `tenant_id` while naming another tenant's user satisfies the policy. The
composite foreign keys `(tenant_id, user_id)` and `(tenant_id, team_id)` are what actually
refuse it; the explicit existence check in front of them exists so the attempt answers
`validation_failed` naming the id rather than a 500 from a constraint.

All four cross-tenant paths, executed against the seeded stack:

| Attempt (as the `northwind` admin)         | Answer                  |
| ------------------------------------------ | ----------------------- |
| `PATCH` a `southwind` user                 | `404 not_found`         |
| `PATCH` a `southwind` team                 | `404 not_found`         |
| Create a team with a `southwind` member    | `400 validation_failed` |
| Give a `northwind` user a `southwind` team | `400 validation_failed` |

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Unknown user: 0192f001-0000-7000-8000-000000000191.",
    "details": [
      {
        "path": "id",
        "message": "0192f001-0000-7000-8000-000000000191 is not in this tenant."
      }
    ],
    "requestId": "7dabe695-5dc2-4b90-81a4-04948d9500fc"
  }
}
```

## Driving this surface locally

Seeded users carry no password hash — a committed password hash is a committed password —
so there is nobody to sign in as on a fresh database. Two ways round it:

**Mint a real account.** Create an invitation and redeem it; acceptance sets the session
cookie. This is the path used for the real-session checks in
[Verification](#verification), and it needs the stub only for the first call.

**Or use the interim role stub.** `AUTH_STUB_ENABLED=true` binds `StubPrincipalSource`
instead of the session reader, and `x-dev-role: admin` (or the `wac_role_stub` cookie the
console sets) picks the role. The environment schema refuses the flag under
`NODE_ENV=production`, so a misconfigured deploy fails to boot rather than serving one
stubbed request.

```bash
curl -H 'x-dev-role: supervisor' \
  http://northwind.app.localhost:3051/api/v1/users
```

What the stub replaces is the **source of the principal**, never the guard. `PermissionGuard`,
the visibility predicate, row-level security and every invariant above run identically
either way, and the stub reads a real `users` row in the tenant the host resolved — so
`tenantId`, `userId` and `teamIds` are never constants. It grants nothing on its own.

Note that with the stub **off**, `x-dev-role` is inert: the header is ignored and the
request is `401 unauthenticated`. Confirmed below.

## Verification

Every request and response on this page was executed against a local stack built from
`main` at `8da8c1f`: `docker compose up -d --wait`, `pnpm db:migrate:deploy`,
`pnpm db:roles`, `pnpm db:roles:login`, `pnpm db:seed`, then the built API. Ids, timestamps
and request ids are the values that run returned. The stack ran on non-default ports
(`55432`, `56379`, API `3051`) because another stack held the defaults, which is why the
examples show `:3051`.

Confirmed rather than assumed:

- An `agent` reading `GET /users` receives `security: null`; an `admin` receives the object.
- A `supervisor` sending `role` is refused `403`, with the `user:set_role` message — the
  privilege-escalation path is closed.
- An `admin` changing **their own** role is refused `403`.
- Suspending the last active admin answers `409 last_admin_required`.
- Creating `retention` when `Retention` exists answers `409 conflict`.
- A `supervisor` is refused `403` on `DELETE /users/{id}`; an `admin` gets `204`, and a
  repeat `DELETE` is `204` again with no second audit row.
- After a removal, the account is absent from `GET /users` and present under
  `?status=removed`, with `occupiesSeat: false`.
- All four cross-tenant attempts in the table above.

**Real sessions, with `AUTH_STUB_ENABLED=false`** — the default, and the only value
production accepts:

- No cookie → `401 unauthenticated`.
- `x-dev-role: admin` with the stub off → `401 unauthenticated`. The header is inert.
- A `wac_session` cookie minted through `POST /api/v1/invites/accept` → `200`, with the new
  agent's `security` correctly `null`.
- That same cookie, after an admin changed the account's role from `agent` to `supervisor`
  → `401 unauthenticated`. The revocation is immediate, on the next request rather than the
  next login.

Session-based role enforcement is therefore **live**, not pending. The interim stub survives
as an opt-in development and test path only; see
[Interim state](../../README.md#interim-state-mock-api-and-stubbed-role).
