# Canned responses API reference

The five routes behind the tenant's shared quick-reply library — `/api/v1/canned-responses`
— and the shortcut mechanism the console builds on top of them. Written for engineers
building against the API or the console.

A **canned response** is standing text a supervisor writes once and an agent expands in the
composer by typing a shortcut such as `/hours`. It is tenant configuration, not an
assignable record: everyone holding `canned_response:read` sees the whole library, and the
visibility predicate that scopes conversations and tickets to their assignee does not apply.

Request and response shapes are defined in `packages/contracts/src/canned-responses.ts` and
validated at the boundary. Enforcement lives in `apps/api/src/canned-responses/`; the
database bounds are in
`apps/api/prisma/migrations/20260816150000_canned_response_shortcut_and_bounds/migration.sql`.

For agents using the picker in the console rather than calling the API, read
[Answer common questions with saved replies](../guides/use-saved-replies.md). The console's
own write surface is **Settings → Saved replies** (`/settings/saved-replies`, TAR-575), which
calls the three routes below through `apps/web/features/canned-responses/`.

> **TODO(author):** the design document this surface is built against —
> `docs/architecture/0011-canned-responses-contract.md` — is cited by
> `packages/contracts/src/canned-responses.ts`, `canned-responses.service.ts`,
> `canned-response-schema.int-spec.ts` and TAR-475's migration, but it is not in this
> repository. Everything those files cite as "0011, decision N" is transcribed here from
> their own comments rather than read from the contract. Was the document dropped before
> merge, and which story owns landing it? Note also that `0011` is already taken by
> `docs/architecture/0011-ticket-reassignment-and-escalation.md`, so it needs a new number.

## Conventions

| Concern           | Rule                                                                              |
| ----------------- | --------------------------------------------------------------------------------- |
| Base path         | `/api/v1`                                                                         |
| Tenant            | Resolved from the request `Host`, never from a body, header or query parameter    |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                   |
| Lists             | `{ items, nextCursor }`. **This list does not paginate** — `nextCursor` is `null` |
| Timestamps        | ISO 8601 with an explicit offset. Serialised as UTC, so always `Z`                |
| Error shape       | The standard envelope, with a code from `packages/contracts/src/error-codes.ts`   |
| `Idempotency-Key` | Not used here. Nothing on this surface has an external side effect                |

**The list is a deviation from 0002's pagination rule, and it has a reason.** The console
resolves a typed shortcut against its own copy of the whole library rather than asking the
server per keystroke, so it needs all of it. `perTenant` is enforced on create, which is
what makes a bounded response a promise the server can keep. The `CursorPage` shape is
retained with `nextCursor` fixed at `null`, so a generic list client works against it
unchanged and pagination stays addable without a breaking change.

**There is deliberately no shortcut-lookup route.** A lookup that answers only once the
agent has stopped typing cannot drive a picker, and the console would still need the list —
two readers of the same data, one of them a request on the keystroke path. See
[How a typed shortcut is resolved](#how-a-typed-shortcut-is-resolved).

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
| The response is in another tenant                | `404 not_found`       |

## Permissions

| Route                                  | Permission              | Held by                  |
| -------------------------------------- | ----------------------- | ------------------------ |
| `GET /api/v1/canned-responses`         | `canned_response:read`  | agent, supervisor, admin |
| `GET /api/v1/canned-responses/{id}`    | `canned_response:read`  | agent, supervisor, admin |
| `POST /api/v1/canned-responses`        | `canned_response:write` | supervisor, admin        |
| `PATCH /api/v1/canned-responses/{id}`  | `canned_response:write` | supervisor, admin        |
| `DELETE /api/v1/canned-responses/{id}` | `canned_response:write` | supervisor, admin        |

Every role reads, supervisor and above writes — the library is curated rather than
crowd-sourced. The matrix is [ADR 0004](../architecture/0004-rbac-permission-matrix.md).
TAR-31's wording says "an admin edits a canned response"; 0004 already reads that as "a
person with the write permission", and nothing narrows it further.

**Canned responses are not subject to the conversation visibility predicate.** They are
tenant configuration, so every principal holding `canned_response:read` sees all of them. A
response the caller cannot see answers `not_found`, never `forbidden`, which would confirm
the id exists somewhere.

## The canned response

```json
{
  "id": "019fee7c-6b21-7a94-b3f0-9d41c2e58a17",
  "shortcut": "/hours",
  "title": "Opening hours",
  "body": "We are open Sunday to Thursday, 09:00-18:00 Riyadh time. Messages sent outside those hours are answered the next working morning.",
  "createdByUserId": "019fed83-ebd1-774d-86e4-46137546a539",
  "createdAt": "2026-08-16T09:14:02.118Z",
  "updatedAt": "2026-08-16T09:14:02.118Z"
}
```

| Field             | Type           | Notes                                                                                                          |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `shortcut`        | string, 1–40   | What the agent types, leading `/` included. Unique per tenant, **case-insensitively** — the column is `citext` |
| `title`           | string, 1–80   | The picker's label. Trimmed before it is measured                                                              |
| `body`            | string, 1–4096 | Literal text, inserted into the draft as-is. Trimmed before it is measured                                     |
| `createdByUserId` | UUID or `null` | The principal that created it. `null` once that user is removed from the tenant                                |
| `createdAt`       | timestamp      |                                                                                                                |
| `updatedAt`       | timestamp      |                                                                                                                |

**`createdByUserId` is stamped from the session, never from the body.** There is no
parameter for it.

**There is no `isShared` field, and the column behind it is not an oversight.**
`canned_responses.is_shared` exists and a CHECK constraint holds it `true` for every row v1
accepts, because TAR-31 scopes this to a tenant-shared library and puts personal (per-agent)
responses out of scope. Publishing the column would add a field the console has to render
and nobody can change. The day personal responses are in scope, that constraint is dropped
as a visible step — and the realtime audience changes with it, from the tenant room to the
owner's.

**The body is literal text. There is no interpolation at v1** — no merge fields, no
placeholder the server fills in. What is stored is what is inserted.

### Limits

Published as `CANNED_RESPONSE_LIMITS` in `packages/contracts/src/canned-responses.ts`, so
the API, the console's `maxLength` and the database bounds cannot disagree.

| Limit            | Value | Covers                                                  |
| ---------------- | ----- | ------------------------------------------------------- |
| `perTenant`      | 200   | The whole library. Enforced on create                   |
| `shortcutLength` | 40    | Characters in a shortcut, **including** the leading `/` |
| `titleLength`    | 80    | Characters in a title, after trimming                   |
| `bodyLength`     | 4096  | Characters in a body, after trimming                    |

`bodyLength` is `SendTextInputSchema.body`'s own ceiling. That is what makes "a canned
response is always sendable as-is" true rather than hoped for — though a body inserted
_beside text the agent already typed_ can still push the draft over it, which the send
refuses rather than the insertion truncating.

`perTenant` is not a plan limit. It is what keeps the unpaginated list honest, which is why
reaching it answers `409 conflict` and not `402 plan_limit_exceeded`: it is a property of
the design, and a `402` would send a supervisor to the billing page to fix something money
cannot.

### The shortcut grammar

`^/[a-z0-9][a-z0-9_-]*$`, capped at 40 characters including the slash. A lowercase letter or
a digit first, then letters, digits, `_` and `-`.

The length cap and the grammar are two separate checks rather than one bounded regular
expression, so an over-long shortcut is refused as too long instead of as malformed.

| Rule                | Why                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Must start with `/` | `/` is the character that opens the composer's picker, published as `CANNED_RESPONSE_TRIGGER`                                       |
| No second `/`       | A shortcut containing the trigger is ambiguous to the picker, and a URL path segment could otherwise be read as one                 |
| No whitespace       | The picker matches a whitespace-delimited token                                                                                     |
| Lowercase only      | The column is `citext`, so `/Hours` and `/hours` are the same key. Accepting both spellings would store one and echo back the other |

The same rule is enforced twice: `CannedResponseShortcutSchema` refuses a bad shortcut at
the boundary with `400 validation_failed`, and `canned_responses_shortcut_format` refuses it
in the database. The database version is written `^/[a-z0-9][a-z0-9_-]{0,38}$` — the same 40
characters, spelled as an explicit bound because a CHECK has no separate length check beside
it.

**Title and body are trimmed by the contract, not by the database.**
`canned_responses_title_length` accepts three spaces on purpose: a CHECK on `trim()` would
be stricter than the schema in front of it, and a constraint stricter than its wire schema
turns a `validation_failed` into a `500`. A whitespace-only title is therefore a `400`,
decided by Zod.

## `GET /api/v1/canned-responses`

The whole library, ascending by `shortcut`.

```bash
curl https://acme.app.example.com/api/v1/canned-responses \
  -b cookies.txt
```

```json
{
  "items": [
    {
      "id": "019fee7c-6b21-7a94-b3f0-9d41c2e58a17",
      "shortcut": "/hours",
      "title": "Opening hours",
      "body": "We are open Sunday to Thursday, 09:00-18:00 Riyadh time.",
      "createdByUserId": "019fed83-ebd1-774d-86e4-46137546a539",
      "createdAt": "2026-08-16T09:14:02.118Z",
      "updatedAt": "2026-08-16T09:14:02.118Z"
    },
    {
      "id": "019fee7c-9a03-7c11-8d52-4b7e0f1a3c88",
      "shortcut": "/vat",
      "title": "VAT number",
      "body": "Our VAT registration number is 300123456700003.",
      "createdByUserId": "019fed83-ebd1-774d-86e4-46137546a539",
      "createdAt": "2026-08-16T09:20:44.702Z",
      "updatedAt": "2026-08-16T09:20:44.702Z"
    }
  ],
  "nextCursor": null
}
```

| Status | Code              | Cause                     |
| ------ | ----------------- | ------------------------- |
| `200`  | —                 |                           |
| `401`  | `unauthenticated` | No session                |
| `403`  | `forbidden`       | No `canned_response:read` |

**Bodies are included, whole.** That is the point of this route: it is what lets the console
expand a typed shortcut without a second request.

The sort comes out of `UNIQUE (tenant_id, shortcut)`, which leads with `tenant_id`, so this
read needs no index of its own.

**The query takes `perTenant + 1` rows, not `perTenant`.** A library that somehow exceeded
the cap — two creates racing at the boundary, see [`POST`](#post-apiv1canned-responses) —
returns 201 items and is visible as a fault rather than silently truncated to look complete.
Nothing paginates it back.

## `GET /api/v1/canned-responses/{id}`

One canned response.

| Status | Code                | Cause                                    |
| ------ | ------------------- | ---------------------------------------- |
| `200`  | —                   |                                          |
| `400`  | `validation_failed` | `{id}` is not a UUID                     |
| `401`  | `unauthenticated`   | No session                               |
| `403`  | `forbidden`         | No `canned_response:read`                |
| `404`  | `not_found`         | Unknown id, or another tenant's response |

The console does not call this route — it holds the whole set already. It is here for a
settings surface that edits one row.

## `POST /api/v1/canned-responses`

Creates a canned response.

**Idempotency.** No `Idempotency-Key`. 0002 requires one for calls with external side
effects — sends and billing. This writes one row and has none. Replaying the call answers
`409 conflict` on the duplicate shortcut.

| Parameter  | In   | Type   | Required | Default | Notes                                                                                     |
| ---------- | ---- | ------ | -------- | ------- | ----------------------------------------------------------------------------------------- |
| `shortcut` | body | string | yes      | —       | 1–40 characters including `/`, matching the grammar, unique per tenant case-insensitively |
| `title`    | body | string | yes      | —       | 1–80 characters after trimming                                                            |
| `body`     | body | string | yes      | —       | 1–4096 characters after trimming                                                          |

```bash
curl -X POST https://acme.app.example.com/api/v1/canned-responses \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{
        "shortcut": "/hours",
        "title": "Opening hours",
        "body": "We are open Sunday to Thursday, 09:00-18:00 Riyadh time."
      }'
```

```json
{
  "id": "019fee7c-6b21-7a94-b3f0-9d41c2e58a17",
  "shortcut": "/hours",
  "title": "Opening hours",
  "body": "We are open Sunday to Thursday, 09:00-18:00 Riyadh time.",
  "createdByUserId": "019fed83-ebd1-774d-86e4-46137546a539",
  "createdAt": "2026-08-16T09:14:02.118Z",
  "updatedAt": "2026-08-16T09:14:02.118Z"
}
```

| Status | Code                | Cause                                                                                                  |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `201`  | —                   |                                                                                                        |
| `400`  | `validation_failed` | The shortcut grammar or length, an empty or whitespace-only title or body, a body over 4096 characters |
| `401`  | `unauthenticated`   | No session                                                                                             |
| `403`  | `forbidden`         | No `canned_response:write`                                                                             |
| `409`  | `conflict`          | The shortcut is already held in this tenant, or `perTenant` is already reached                         |

The two `409`s carry different messages. The duplicate says the shortcut exists **and that
shortcuts are case-insensitive**, because "`/Hours` already exists" reads as nonsense to
somebody who typed `/hours`; the cap says how many the tenant holds and that one must be
deleted or merged before another is added.

**The cap is checked, then the row is written**, so two creates racing at the boundary can
both pass and leave the tenant one response over 200. That is accepted rather than locked,
on the same reasoning the routing-rule cap uses: the consequence is a 201st row on a bound
that exists to keep the list honest, not a correctness failure, and an advisory lock on a
write a supervisor makes a few times a month is a heavier mechanism than the risk deserves.

## `PATCH /api/v1/canned-responses/{id}`

Partial update. `shortcut`, `title` and `body` are each optional and follow the create
rules.

**Idempotency.** No `Idempotency-Key`, and none is needed: the call is naturally idempotent.
Replaying it writes nothing the second time — see below.

```bash
curl -X PATCH https://acme.app.example.com/api/v1/canned-responses/019fee7c-6b21-7a94-b3f0-9d41c2e58a17 \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"body": "We are open Sunday to Thursday, 09:00-17:00 Riyadh time."}'
```

| Status | Code                | Cause                                                                                      |
| ------ | ------------------- | ------------------------------------------------------------------------------------------ |
| `200`  | —                   |                                                                                            |
| `400`  | `validation_failed` | `{id}` is not a UUID, or a field breaks the create rules                                   |
| `401`  | `unauthenticated`   | No session                                                                                 |
| `403`  | `forbidden`         | No `canned_response:write`                                                                 |
| `404`  | `not_found`         | Unknown id, or another tenant's response. Never `forbidden`, which would confirm it exists |
| `409`  | `conflict`          | The new shortcut is already held in this tenant                                            |

**A patch that moves no column writes nothing, audits nothing and announces nothing.** An
absent field and a field set to the value the row already holds are the same thing here: a
broadcast that says nothing is still a broadcast, and it would cost every console on the
tenant a refetch. The response is the row as it stands, so a caller cannot tell the no-op
from a write that happened to produce the same values — deliberately, because a shape that
distinguished them would invite a caller to announce the second.

**The cap is not re-checked.** A patch cannot add a row.

## `DELETE /api/v1/canned-responses/{id}`

`204`, and **idempotent**: deleting an already-deleted response is `204`, not `404`.

**Idempotency.** No `Idempotency-Key`. Replaying the call succeeds, writes no second audit
row and announces nothing the second time.

| Status | Code                | Cause                      |
| ------ | ------------------- | -------------------------- |
| `204`  | —                   |                            |
| `400`  | `validation_failed` | `{id}` is not a UUID       |
| `401`  | `unauthenticated`   | No session                 |
| `403`  | `forbidden`         | No `canned_response:write` |

**Nothing references a canned response, so nothing has to be cleared first.** The body is
copied into the draft at insertion time and the message that was sent is its own row.
Deleting a response changes no message that already used it.

## Auditing

Every write that moved something writes one `audit_logs` row, under `targetType`
`canned_response`.

| Action                    | Written by                  |
| ------------------------- | --------------------------- |
| `canned_response.created` | `POST`                      |
| `canned_response.updated` | `PATCH` that moved a column |
| `canned_response.deleted` | `DELETE` that found a row   |

The metadata carries `shortcut` and `title`, **never `body`**. A body is free-form copy that
can carry customer-specific detail, and `audit_logs` is exported for compliance review
rather than being a place to discover it — the same reasoning `assignment_rule.*` applies to
its conditions.

A canned response is text sent to a customer under the tenant's name, which is why this
surface is audited at all: it is the same class of change as a routing rule.

## Realtime

Every write that moved something emits `canned_response.changed` on the in-process bus
**after the transaction commits**, and the relay turns it into one of two server events.

| Server event              | Payload                                   | Sent when                    |
| ------------------------- | ----------------------------------------- | ---------------------------- |
| `canned_response.saved`   | `{ cannedResponse }` — the whole resource | A create or an update landed |
| `canned_response.deleted` | `{ cannedResponseId }` — the id alone     | A delete removed a row       |

**Room:** `tenant:{tenantId}:canned-response-readers`, the sockets whose principal holds
`canned_response:read`. This is the one relay whose audience is not a conversation's: the
library is tenant configuration everyone may read, so the room is derived from the
permission rather than from a thread's audience. Under today's `ROLE_PERMISSIONS` that is
the same set of sockets as the tenant room — the room stays separate anyway, because the
equality is a fact about a constant while "a fan-out wider than the read rule is an
authorization bypass" is a rule.

**One event for both create and update**, unlike the audit trail, which distinguishes them:
an auditor asks who added a row, while every consumer of this event performs the same
upsert, and a discriminant nothing branches on is a discriminant that drifts.

`saved` carries the committed row, read back by the relay in its own tenant scope rather
than taken from the writer's view of it, so a console that prefers to patch its cache can.
`deleted` carries the id alone, because there is no row left to read back. If the row is
already gone when the relay reads it — a delete racing the save's own event — nothing is
published, and the `canned_response.deleted` that delete emits is what makes the console
converge.

The shipped console refetches rather than patching: the inbox route server-renders the
library and hands it to the composer as a prop, so the same refresh that carries a new
message also carries the supervisor's edit.

## How a typed shortcut is resolved

In the browser, against the console's own copy of the library. No request is made while the
agent types.

1. The inbox route reads `GET /api/v1/canned-responses` on the server and passes the set
   into the composer.
2. `shortcutTokenBefore(draft, caret)` finds the token immediately before the caret, using
   `(?:^|\s)` followed by the trigger and the characters after it, case-insensitively. That
   leading `(?:^|\s)` is load-bearing: without it, a URL ending in `/hours` opens a picker
   in the middle of a link. Only the text _before_ the caret is examined, so editing back
   into a finished sentence does not reopen one.
3. `matchCannedResponses(responses, query)` ranks shortcut-prefix matches first, then titles
   containing the same term, each group ascending by shortcut, capped at
   `CANNED_RESPONSE_MATCH_LIMIT` (8). Bodies are not searched.
4. `insertCannedResponse` replaces the token with the body and leaves the rest of the draft
   alone, putting the caret at the end of what was inserted.

Two properties this arrangement is built to hold:

- **Nothing here can fail.** A draft with no token matches nothing; a query that matches
  nothing returns an empty list. The loader turns an unreachable endpoint — including the
  `403` a role without `canned_response:read` would get — into an empty set and logs it, so
  the composer renders without a picker and sends still work. Degradation is the absence of
  a result, never an error.
- **Nothing is sent automatically.** Insertion produces an ordinary editable draft. While
  the picker is open, `Enter` commits the highlighted entry and its default is prevented,
  and the composer's send has always been a submit button rather than a keystroke — so there
  is no path from a shortcut to a customer without an agent reading the text first.

## Security and isolation

- **Every statement runs on `TenantPrisma`**, carrying the `app.tenant_id` GUC and filtered
  by row-level security. The service takes no tenant id from a caller — there is no
  parameter for one — which makes "no cross-tenant read or write under any role" a property
  of the wiring rather than of remembering a filter.
- **Another tenant's id is `not_found`, never `403`.** Row-level security means the row is
  simply not visible, so the server genuinely cannot distinguish it from an id that never
  existed. A `403` would confirm the id exists somewhere.
- **`UNIQUE (tenant_id, shortcut)` leads with `tenant_id`**, so a `409` can only ever be
  caused by this tenant's own row. Two tenants may both hold `/hours`, and the constraint
  cannot be used as an oracle for another tenant's shortcut namespace.
- **Bodies never reach `audit_logs`.** See [Auditing](#auditing).

## Known gaps

Stated rather than left to be discovered.

- **No personal responses.** Every row is shared with the whole tenant, enforced by
  `canned_responses_is_shared`.
- **No interpolation.** Bodies are literal text; there are no merge fields.
- **No body search.** The picker matches on shortcut and title only.
- **No usage counters.** Nothing records which responses are expanded, so there is no way to
  find the ones nobody uses.
- **The cap can be exceeded by one under a race.** See [`POST`](#post-apiv1canned-responses).

## Verification

- `apps/api/src/canned-responses/canned-responses.int-spec.ts` — the CRUD surface, the
  permission split, the after-commit announcements, and cross-tenant isolation across two
  tenants.
- `apps/api/src/prisma/canned-response-schema.int-spec.ts` — fails if any of the four CHECK
  constraints goes missing. Prisma cannot express a CHECK and its describer ignores them, so
  nothing regenerates them from `schema.prisma`.
- `packages/contracts/src/canned-responses.test.ts` — the published shapes and bounds.
- `apps/web/features/inbox/canned-response-match.test.ts` and
  `useCannedResponsePicker.test.ts` — tokenising, ranking, insertion and the keyboard.
