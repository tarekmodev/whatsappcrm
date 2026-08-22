# Platform admin API reference

The tenant provisioning and deactivation endpoints, and the parked-webhook replay. Written for
engineers and for the platform operator who runs a provisioning script or recovers a message that
failed ingestion.

Every route here is operated by us, never by a customer. Nothing on this surface is
reachable by a tenant's own users under any role, and none of it goes through the session
and RBAC model that TAR-35 and TAR-22 build for tenant-facing routes.

**A tenant can also provision itself.** `POST /api/v1/signup/verify` reaches
`TenantProvisioningService` down a second path and leaves the tenant `trialing` rather than
`active` — see [the signup API reference](signup-api.md) and
[the tenant lifecycle reference](tenant-lifecycle.md#provisioning-two-paths-two-starting-states).
The operator routes on this page stay the fallback for a deployment with `SIGNUP_ENABLED=false`.
The lifecycle routes 0009 specifies for an operator — reactivate, cancel, delete and the
lifecycle read — are published and not implemented.

**This page covers the two tenant lifecycle routes and the webhook replay route.**
`/api/v1/admin/*` also carries
`POST /api/v1/admin/tenants/{slug}/whatsapp/business-accounts` and its
`{wabaId}/template-sync` sibling, both behind the same `PlatformAdminGuard`. They are
TAR-66's to document; see `apps/api/src/whatsapp/admin/admin-whatsapp.controller.ts` and
amendment 1 of
[the architecture document](../architecture/0002-architecture-and-api-contract.md#amendment-1--message-templates-tar-20a),
which records what is still open about them — whether a tenant may connect its own WABA, a
product call that decides the path but not the guard.

Request and response shapes are defined in `packages/contracts/src/admin.ts` and validated
at the boundary; the tables below are derived from those schemas and from
`apps/api/src/tenancy/admin/admin-tenants.controller.ts`. Every example on this page was
executed against a local stack built from `main` — see [Verification](#verification).

## Conventions

| Concern           | Rule                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------ |
| Base path         | `/api/v1`. The API also serves an unversioned `/api/health`                          |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                      |
| Timestamps        | ISO 8601 with an explicit offset                                                     |
| Success shape     | The resource itself. No envelope                                                     |
| Error shape       | The envelope below, always, with a code from `packages/contracts/src/error-codes.ts` |
| Rate limiting     | Not implemented on this surface yet. TAR-41 owns limits                              |
| `Idempotency-Key` | Not used here. Both routes are idempotent on the tenant's `slug` instead             |

### Error envelope

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request body failed validation.",
    "details": [{ "path": "slug", "message": "Too small: expected string to have >=3 characters" }],
    "requestId": "9e2c1de5-f315-42ec-bf89-aebe8ec20e09"
  }
}
```

`details` is present on validation failures only. `requestId` is on every error and is
echoed in the `x-request-id` response header, which is what ties an operator's report to a
log line. Send your own `x-request-id` to correlate across services: up to 128 characters
from `A-Za-z0-9._-`. Anything longer or outside that set is replaced with a fresh UUID
rather than truncated, so an id that comes back changed did not meet the rule.

## Authentication

Every request to `/api/v1/admin/*` presents a bearer token that matches the **secret half**
of an entry in `PLATFORM_ADMIN_TOKEN`:

```text
Authorization: Bearer <secret>
```

`PLATFORM_ADMIN_TOKEN` holds comma-separated `label:secret` entries, one per operator or
automation:

```text
PLATFORM_ADMIN_TOKEN=ops-alice:<secret>,ci-provisioner:<secret>
```

The platform operator is not a user inside any tenant, and provisioning has to work before
the first tenant — and therefore the first user — exists, so there is nothing for a session
lookup or a per-tenant role to resolve them against.

- **Unset means the surface is off.** With no `PLATFORM_ADMIN_TOKEN` configured, every
  request is refused with `401 unauthenticated`. That is the safe default for routes that
  create tenants.
- **Malformed means the API does not start.** An unlabelled entry, a secret under 32
  characters, a label outside 2–40 characters of `a-z0-9._-`, a repeated label, or one
  secret under two labels each fail validation at boot. There is no transitional acceptance
  of the old unlabelled form (TAR-166): a bare secret authenticates fine and writes an audit
  row that cannot name who acted, which is the gap this closes.
- **One answer for every failure.** A missing header, a non-`Bearer` scheme and a wrong
  token are indistinguishable in the response, and so is one operator's credential from
  another's. The reason is logged, not returned.
- **Comparison is constant time, with no early exit.** Both sides are hashed to a fixed 32
  bytes and compared with `timingSafeEqual`, and every configured entry is compared on every
  request even after one has matched — so neither the token's length, how far a guess
  matched, nor an entry's position in the set is observable.
- **The label is recorded, the secret never is.** The label of the entry that matched is
  written to `audit_logs.actor_label` with `actor_type = 'platform_operator'`, so "everything
  this operator did" is a query rather than an inference. Nothing logs, returns or stores the
  secret half.

What this is still not: an identity with a session, per-route authorisation or a directory
behind it. Every entry is authorised for every tenant. It is a placeholder for a real
platform-admin identity, which arrives with TAR-22 and TAR-35; the guard is the only thing
that has to change.

## `POST /api/v1/admin/tenants`

Provision a tenant: create the tenant, its settings and its platform subdomain, in one
transaction.

**Authentication.** Platform admin token. See above.

**Idempotency.** Idempotent on `slug`. `201` means this call created the tenant, `200`
means it already existed — the body is identical either way, because an idempotent
operation that reports a different resource on replay is not idempotent.

### Request

| Parameter  | In   | Type   | Required | Default | Notes                                                                                                  |
| ---------- | ---- | ------ | -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `slug`     | body | string | yes      | —       | 3–40 characters, `^[a-z0-9][a-z0-9-]*[a-z0-9]$`. Becomes a DNS label, so no leading or trailing hyphen |
| `name`     | body | string | yes      | —       | 1–120 characters. Display name                                                                         |
| `timezone` | body | string | no       | `UTC`   | IANA zone name, validated against the runtime's tz database. Never a fixed offset or an abbreviation   |
| `locale`   | body | string | no       | `en`    | `^[a-z]{2}(-[A-Z]{2})?$` — `en`, `ar`, `en-GB`                                                         |

`slug` is required rather than derived from `name`: it is the identity of the request, it
is baked into the platform subdomain, and it is immutable once issued. Deriving it would
hand a typo in a display name to DNS permanently.

```bash
curl -X POST http://localhost:3001/api/v1/admin/tenants \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"acme","name":"Acme Ltd","timezone":"Europe/London","locale":"en-GB"}'
```

### Response

`201 Created` on the call that provisioned the tenant:

```json
{
  "id": "019fed83-ebd1-774d-86e4-46137546a539",
  "slug": "acme",
  "name": "Acme Ltd",
  "status": "active",
  "primaryHostname": "acme.app.localhost",
  "settings": { "timezone": "Europe/London", "locale": "en-GB" },
  "createdAt": "2026-08-10T21:11:13.618Z"
}
```

`200 OK` on any repeat, with the same body.

| Field             | Type                                                | Notes                                                                       |
| ----------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| `id`              | UUID                                                | UUIDv7                                                                      |
| `slug`            | string                                              | As requested                                                                |
| `name`            | string                                              | As **stored**, which on a replay is the original name, not the one you sent |
| `status`          | `pending` \| `active` \| `suspended` \| `cancelled` | `active` on a successful provision                                          |
| `primaryHostname` | string, ≤253                                        | `<slug>.$PLATFORM_DOMAIN`, lowercased                                       |
| `settings`        | object                                              | `timezone` and `locale` as stored                                           |
| `createdAt`       | ISO 8601                                            | When the tenant row was written                                             |

### Errors

| Status | Code                | Cause                                                                                                          |
| ------ | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `400`  | `validation_failed` | A field failed the schema. `details` names each one                                                            |
| `401`  | `unauthenticated`   | Missing, malformed or wrong bearer token; or `PLATFORM_ADMIN_TOKEN` is unset                                   |
| `409`  | `conflict`          | The derived platform hostname is already claimed by another tenant, or the slug was taken by a concurrent call |
| `500`  | —                   | Anything else. Reported as a fault, not as the operator's mistake                                              |

```json
{
  "error": {
    "code": "conflict",
    "message": "The platform hostname acme-three.app.localhost is already claimed by another tenant. Provision this tenant under a different slug, or release the hostname first.",
    "requestId": "6a6c7faf-2030-4b3d-bb6c-3a1d515c5e19"
  }
}
```

### What it writes, and what it does not

Three rows, in one transaction:

| Table             | Row                                                             |
| ----------------- | --------------------------------------------------------------- |
| `tenants`         | `status = 'active'`, the slug and the name                      |
| `tenant_settings` | `timezone` and `locale`                                         |
| `tenant_domains`  | `kind = 'platform'`, `is_primary = true`, `verified_at` stamped |

The domain row is not optional bookkeeping: host → tenant resolution is how every request
finds its tenant, and a tenant with no domain is unreachable by every entry point in the
system.

Nothing else is written. No users — inviting the first one is TAR-35. No branding row —
TAR-29 owns branding, including whether that row is written eagerly. No subscription —
TAR-37. Seeding a table another story owns would fix its defaults in the wrong place.

Points worth knowing before you call it:

- **The hostname is derived, never accepted from the request.** A client-supplied hostname
  is how one tenant claims another's subdomain. If another tenant already holds the derived
  host, the whole call is refused and nothing is written — there is no half-provisioned
  tenant to clean up.
- **A replay never mutates.** It does not rename the tenant, change its status or reset its
  settings; renaming is `PATCH /api/v1/tenant` and reactivation is TAR-36's lifecycle, not
  a side effect of re-running a script. It _does_ add a settings row or a platform domain
  that is missing, which is the repair half of idempotency.
- **The status is never observably `pending`.** Provisioning completes inside the
  transaction, so the tenant row exists only once everything it needs exists with it. The
  column defaults to `pending` for rows written by anything other than this service.
- **Concurrent calls for one slug serialise.** The transaction takes a transaction-scoped
  advisory lock on the slug, so a lost race becomes a wait rather than an error the
  operator has to interpret. The unique index on `tenants.slug` remains the actual
  guarantee.
- **It runs on `SystemPrisma`** — the only client that can write `tenants` — and is one of
  the five call sites the architecture document permits for it.

## `POST /api/v1/admin/tenants/{slug}/deactivate`

Revoke a tenant's access and keep its data.

**Authentication.** Platform admin token. See above.

**Idempotency.** Idempotent on `slug`, and always `200`. Deactivation creates nothing, and
a repeat call on a tenant that is already inaccessible is a no-op rather than a different
outcome worth a different code.

### Request

| Parameter | In   | Type   | Required | Default | Notes                                                                      |
| --------- | ---- | ------ | -------- | ------- | -------------------------------------------------------------------------- |
| `slug`    | path | string | yes      | —       | Same format as provisioning: 3–40 characters, DNS-label safe               |
| `reason`  | body | string | no       | —       | 1–500 characters. Free text for the audit trail, never shown to the tenant |

The body may be `{}`. An operator acting on an incident should not be blocked by a required
field.

```bash
curl -X POST http://localhost:3001/api/v1/admin/tenants/acme/deactivate \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Non-payment, ticket OPS-412"}'
```

### Response

`200 OK`:

```json
{
  "id": "019fed83-ebd1-774d-86e4-46137546a539",
  "slug": "acme",
  "name": "Acme Ltd",
  "status": "suspended",
  "suspendedAt": "2026-08-10T21:11:19.758Z"
}
```

| Field         | Type                                                | Notes                                                                               |
| ------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `status`      | `pending` \| `active` \| `suspended` \| `cancelled` | `suspended` after this call. A tenant already `cancelled` stays `cancelled`         |
| `suspendedAt` | ISO 8601, nullable                                  | When access was revoked. Null if the tenant reached a non-active status another way |

`suspendedAt` says when deactivation happened, not that it did — a `pending` row abandoned
by a failed provision, or a `cancelled` one closed by TAR-36, is already inaccessible and
carries no timestamp. A replay keeps the original value, which is the record of when access
was actually revoked and has to survive a re-run.

### Errors

| Status | Code                | Cause                                                                            |
| ------ | ------------------- | -------------------------------------------------------------------------------- |
| `400`  | `validation_failed` | `reason` is empty or longer than 500 characters, or `slug` fails the path format |
| `401`  | `unauthenticated`   | Missing, malformed or wrong bearer token                                         |
| `404`  | `not_found`         | No tenant carries that slug                                                      |

```json
{
  "error": {
    "code": "not_found",
    "message": "No tenant is provisioned with the slug nosuchtenant.",
    "requestId": "2b2a9ba4-da20-4a58-8405-3406c25bc0c8"
  }
}
```

A typo answers `404` rather than `200` on purpose. Answering `200` would let an operator
believe a tenant that is still serving traffic had been stopped.

> On a malformed path parameter the envelope's `message` reads "The request body failed
> validation." even though the fault is in the path. The `code` and `details` are correct;
> only the sentence is. Behaviour of `ZodValidationPipe`, which has one message for every
> parameter kind.

### Retention behaviour

**It is not a delete, and there is nothing to undo.** Two columns are written —
`tenants.status` and `tenants.suspended_at` — and one `audit_logs` row, in the same
transaction. Every contact, conversation, ticket, message and attachment stays exactly where
it was and stays reachable through `SystemPrisma` for support, billing, export and
reactivation. Deletion is a separate operation with a retention window, and it is not this
one.

**The block is in the database, not in a guard.** `public.assert_tenant_active` is called by
every `TenantPrisma` statement on its way to setting the row-level security GUC, so the
tenant's agents stop reaching their data on their very next query — through open sessions,
in-flight background jobs, WebSocket handlers and raw SQL alike. The status is read inside
the transaction that is about to run, not from a cache, so the revocation is in force from
the instant this call commits. There is no window, and no new route can forget to apply it.
The mechanism is described in [`tenancy.md`](tenancy.md#the-deactivation-gate).

**No other tenant is affected.** One row is written, and the gate reads only the row the GUC
names. `apps/api/src/tenancy/tenant-deactivation.int-spec.ts` is the regression proof: it
deactivates one tenant and asserts its neighbour still reads, writes and runs transactions
normally.

**What it deliberately leaves alone:**

- **Sessions are not revoked.** TAR-35 owns `sessions` and login, and must refuse a
  non-active tenant there so a deactivated tenant cannot get as far as a session. The gate
  means such a session would reach no data in any case.
- **Reactivation is not here.** `suspended → active` belongs to TAR-36's lifecycle state
  machine; an endpoint that exists to take access away should not also be the one that gives
  it back. Until it ships, an operator restores a tenant by setting `status` back to `active`
  through the platform's own database access.
- **Inbound webhooks are unaffected at the ingest boundary.** `webhook_events` is written by
  `SystemPrisma` before any tenant is in scope, so Meta is not refused and real customer
  messages are not lost. Only the tenant-scoped processing behind it is blocked.

**A `pending` or `cancelled` tenant is blocked by the same gate.** Only `active` reaches
data, so a half-provisioned tenant is closed by the mechanism rather than by a second rule.

### The audit entry

One `audit_logs` row per call that actually deactivated something, written in the same
transaction as the status change:

| Column          | Value                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| `action`        | `tenant.deactivated`                                                      |
| `target_type`   | `tenant`                                                                  |
| `target_id`     | The tenant's id                                                           |
| `actor_type`    | `platform_operator`                                                       |
| `actor_user_id` | `null` — the actor is the platform operator, never a user in this tenant  |
| `actor_label`   | The label of the `PLATFORM_ADMIN_TOKEN` entry that authenticated the call |
| `metadata`      | `{ "reason": "..." }`, or absent when no reason was given                 |
| `created_at`    | The same `now()` written to `tenants.suspended_at`                        |

`actor_type` and `actor_label` arrived with TAR-166. Before them a null `actor_user_id` said
both "the platform acted" and "nothing recorded who"; now `SELECT * FROM audit_logs WHERE
tenant_id = $1 AND actor_type = 'platform_operator'` answers "everything an operator did to
this tenant", and the label says which one.

Both timestamps come from the database clock, read once at transaction start. Two API
instances a few seconds apart would otherwise be able to order the audit trail
inconsistently with the row it describes.

## `POST /api/v1/admin/webhook-events/{webhookEventId}/replay`

Put a parked inbound event back in front of the sweeper (TAR-94).

Ingest stores every signed delivery to `webhook_events` before it routes it, and parks the ones
it cannot apply — an `unknown_phone_number_id`, a deactivated tenant — `failed`, with the raw
payload intact. A parked row is deliberately **not** claimable, so re-enqueueing one does nothing:
recovery is a reset back to `received`, which the next sweep collects. This is the authorised way
to perform that reset. Before it, the only way was an `UPDATE webhook_events` typed into psql,
with nothing recording that anybody had.

Find what is parked first — the query is in [the README](../../README.md#what-happens-after-the-200):

```sql
SELECT id, split_part(last_error, ':', 1) AS reason
FROM webhook_events WHERE status = 'failed' ORDER BY received_at;
```

**This route names no tenant**, unlike everything else on this surface. That is the case it exists
for rather than an omission: the event most worth replaying is one whose number was connected
_after_ its customers messaged it, so its `tenant_id` is still NULL and there is no tenant to
enter. The tenant boundary is enforced where it always was — the processor re-resolves
`phone_number_id` → tenant on the next sweep and opens that tenant's scope before writing a
message.

### Request

No body. The event id is the whole request.

| Parameter        | In   | Rule           |
| ---------------- | ---- | -------------- |
| `webhookEventId` | Path | UUID, required |

```bash
curl -X POST -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  http://localhost:3001/api/v1/admin/webhook-events/01a02b9d-c0bd-708a-b184-18a7f7cf5eca/replay
```

### Response

`200`, always — not `202`. What the call does is complete and durable when it answers: the row is
`received` and the trail row is committed. What happens _next_ is the sweep, and the thing to poll
for that is `webhook_events.status`, which the operator already has.

```json
{
  "id": "01a02b9d-c0bd-708a-b184-18a7f7cf5eca",
  "provider": "whatsapp",
  "status": "received",
  "parkedError": "unknown_phone_number_id: no whatsapp_accounts row for tar94-doc-unconnected",
  "replayedAt": "2026-08-22T22:36:08.674Z"
}
```

| Field         | Meaning                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `status`      | Always `received`. It is what the sweeper scans for, which is why it is reported              |
| `parkedError` | The `last_error` the row carried. The reset clears it, so this is the only copy in the answer |
| `replayedAt`  | When the reset committed — **not** when the event will be reprocessed                         |
| `provider`    | Which sweeper collects it. Only the WhatsApp sweep runs today (see below)                     |

Reprocessing happens on the next sweep, up to `WEBHOOK_STUCK_AFTER_MS` later. `attempts` goes back
to zero along with the status: the retry budget belongs to the attempt to apply an event rather
than to the event, so a row parked with `attempts_exhausted` and replayed with its attempts intact
would be parked again by the first transient failure.

⚠️ **A `billing` event is reset and then waits.** The sweeper scans `provider = 'whatsapp'` only,
because each provider has its own queue and worker, and TAR-37's billing worker is not on `main`.
Replaying one is not refused — the reset is correct and the row is recoverable — but nothing
collects it until that worker exists. `provider` in the response is how you can tell.

### Errors

| Status | Code                | When                                                                  |
| ------ | ------------------- | --------------------------------------------------------------------- |
| `400`  | `validation_failed` | `webhookEventId` is not a UUID                                        |
| `401`  | `unauthenticated`   | Missing, malformed or wrong bearer token                              |
| `404`  | `not_found`         | No stored event has that id                                           |
| `409`  | `conflict`          | The row is `received`, `processing` or `processed` — it is not parked |

The `409` is the one worth stating out loud. A repeat replay has nothing to do, and answering
`200` would tell an operator mid-incident that they had just recovered a message when they had
not — the same class of quiet no-op as the sweeper job-id collision TAR-67 fixed. The message
names the status, because it decides what to do next: `received` and `processing` mean the sweeper
already has it, `processed` means it succeeded and there is nothing to recover.

```json
{
  "error": {
    "code": "conflict",
    "message": "This webhook event is received, not parked, so there is nothing to replay. Only an event that failed ingestion can be replayed.",
    "requestId": "4ab941b1-5723-4da2-93b0-c515761d913e"
  }
}
```

### What it writes

Two statements, one transaction, so an event cannot be replayed with nothing recording who did it
and a trail row cannot describe a reset that rolled back:

```text
webhook_events         status → 'received', attempts → 0, last_error → NULL
                       guarded by WHERE status = 'failed', which is what makes two
                       concurrent replays produce one reset and one 409
webhook_event_replays  one row: the event, the operator credential's label, the
                       last_error being recovered, and when
```

```sql
SELECT actor_label, parked_error, replayed_at FROM webhook_event_replays
WHERE webhook_event_id = $1 ORDER BY replayed_at;
--  local-dev | unknown_phone_number_id: no whatsapp_accounts row for … | 2026-08-22 22:36:08.674+00
```

**Not an `audit_logs` row, and that is deliberate.** `audit_logs.tenant_id` is NOT NULL and
policy-filtered, and the event this exists to recover is precisely the one with no tenant. Filing
the entry under a tenant the operator asserted would put an invention into the table whose entire
value is being right about what happened. `webhook_event_replays` therefore takes the posture of
the table it describes: no `tenant_id`, no RLS policy, no grant for the app role, and append-only
— the grant withholds UPDATE and DELETE from `SystemPrisma` too, and a trigger refuses the table
owner on top of that.

## Verification

Every request and response on this page was executed against a local stack: `pnpm db:up`,
`pnpm db:migrate:deploy`, `pnpm db:roles`, `pnpm db:roles:login`, then the built API on
`http://localhost:3001` with `.env` copied from `.env.example`. Ids, hostnames, timestamps
and request ids are the real values that run returned; the `.app.localhost` hostnames come
from the local `PLATFORM_DOMAIN`, which is `app.example.com`-shaped in a deployed
environment.

Re-run in full after `main` reached `6b900e2`, because TAR-66 refactored
`TenantProvisioningService`'s unique-violation handling out into
`apps/api/src/prisma/unique-violation.ts`. Every status code, body and error message below
came back identical.

The `409` example was produced by claiming `acme-three.app.localhost` for a different tenant
and then provisioning the slug `acme-three`. That call wrote nothing: no `acme-three` row
exists afterwards.

Two behaviours confirmed rather than assumed:

- A replay sending a different `name` and different settings returned the **original**
  stored values and changed nothing.
- A second `deactivate` call returned the **original** `suspendedAt`.

The webhook replay section was executed against the same stack on TAR-94's branch. The parked row
was produced the way a real one is — a signed delivery to `POST /api/webhooks/whatsapp` naming a
`phone_number_id` no tenant has connected — and every status code, body and `requestId` above is
what that run returned, including the `409` from calling replay twice and the `400` from an id
that is not a UUID.
