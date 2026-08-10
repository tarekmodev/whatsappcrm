# Platform admin API reference

`/api/v1/admin/*` — the routes the platform operator calls, never a customer. Written for
engineers and for whoever runs provisioning scripts.

Two endpoints exist today: provision a tenant, and deactivate one. Both come from TAR-19.
The rest of the tenant lifecycle — reactivation, deletion, plan changes — belongs to TAR-36
and is not built.

Every shape on this page is defined in
[`packages/contracts/src/admin.ts`](../../packages/contracts/src/admin.ts) and validated on
the way in. The contract is the source of truth; this page is the reading version of it.

## Authentication

A shared bearer token in the `Authorization` header:

```
Authorization: Bearer <PLATFORM_ADMIN_TOKEN>
```

The token comes from the `PLATFORM_ADMIN_TOKEN` environment variable — minimum 32
characters, generated with `openssl rand -base64 48`, and held in the environment's secret
store. It is compared in constant time against a SHA-256 of both sides, so neither the
token's length nor how far a guess matched is observable.

**Leaving `PLATFORM_ADMIN_TOKEN` unset disables the whole admin surface.** Every request is
refused with `401 unauthenticated`. That is the intended default for an environment that was
never given a token: it cannot provision tenants rather than provisioning for anybody who
asks.

The guard is declared on the controller, not per route, so a route added later is protected
by default instead of by remembering.

**This is a placeholder, and it is worth knowing why.** The platform operator is not a user
inside any tenant, so there is nothing for TAR-35's session lookup or TAR-22's per-tenant
roles to resolve them against — and provisioning has to work before the first tenant, and
therefore the first user, exists. A single shared secret has no identity, no per-operator
revocation and no audit trail beyond "someone with the token". Replace it when a real
platform-admin identity exists; the guard is the only thing that has to change.

Every failure — absent header, wrong scheme, wrong token, unconfigured environment — returns
the same body, so the response cannot be used to work out which it was. The reason is logged,
not returned.

## Errors

Every non-2xx response uses the envelope from
[`packages/contracts/src/error.ts`](../../packages/contracts/src/error.ts):

```json
{
  "error": {
    "code": "conflict",
    "message": "The platform hostname acme.app.example.com is already claimed by another tenant. Provision this tenant under a different slug, or release the hostname first.",
    "requestId": "6b1f2c8e-3a4d-4f91-8c02-9d7e5a1b3f40"
  }
}
```

`code` is stable and machine-readable — branch on it. `message` is for a human and may
change. `requestId` is echoed on every response as the `x-request-id` header and is what ties
an operator's report to a log line; quote it when escalating.

`details` is present only on `validation_failed`, and carries one entry per offending field:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request body failed validation.",
    "details": [
      {
        "path": "slug",
        "message": "Must be lowercase letters, digits and hyphens, starting and ending with a letter or digit"
      }
    ],
    "requestId": "6b1f2c8e-3a4d-4f91-8c02-9d7e5a1b3f40"
  }
}
```

**Unknown keys in a request body are stripped, not rejected.** A client sending a field from
a newer version keeps working, and mass assignment is prevented by the strip rather than by a 400.

**A `500` does not carry this envelope yet.** `ApiExceptionFilter` is bound per controller
and renders only the errors these routes raise deliberately. An unexpected fault falls
through to Nest's default handler and answers
`{"statusCode":500,"message":"Internal server error"}` with no `code` and no `requestId`.
TAR-41 owns the global filter that gives every fault the envelope and the `internal_error`
code; until it lands, correlate a 500 through the `x-request-id` response header instead.

---

## `POST /api/v1/admin/tenants`

Provision a tenant. Creates the tenant, its settings row and its platform subdomain in one
transaction, and nothing else.

**Authentication:** platform admin token. Without it, `401 unauthenticated`.

### Request body

| Field      | Type   | Required | Default | Description                                                                                                     |
| ---------- | ------ | -------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `slug`     | string | yes      | —       | 3–40 characters, `^[a-z0-9][a-z0-9-]*[a-z0-9]$`. Becomes the platform subdomain and the identity of the request |
| `name`     | string | yes      | —       | 1–120 characters. The display name                                                                              |
| `timezone` | string | no       | `UTC`   | IANA zone name such as `Europe/London`, validated against the runtime's tz database                             |
| `locale`   | string | no       | `en`    | `^[a-z]{2}(-[A-Z]{2})?$` — `en`, `ar`, `en-GB`                                                                  |

`slug` is required rather than derived from `name`. Deriving it would hand a typo in a
display name to DNS permanently: the slug is baked into the platform subdomain and into every
session cookie scoped to that host, so it cannot be changed later.

The slug pattern forbids a leading or trailing hyphen because the slug becomes a DNS label,
and a label may not start or end with one.

`timezone` drives business hours, SLA calculation and report bucketing. It is validated
against the runtime's own tz database rather than a regular expression, because only the ICU
data can say whether a name actually resolves — and a zone that does not resolve makes every
SLA calculation for that tenant silently wrong.

### Request

```bash
curl -X POST http://localhost:3001/api/v1/admin/tenants \
  -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"acme","name":"Acme Ltd","timezone":"Europe/London","locale":"en-GB"}'
```

### Response — `201 Created` or `200 OK`

```json
{
  "id": "019f8c3d-4a2b-7c1e-9f00-2b6d4e8a1c53",
  "slug": "acme",
  "name": "Acme Ltd",
  "status": "active",
  "primaryHostname": "acme.app.localhost",
  "settings": { "timezone": "Europe/London", "locale": "en-GB" },
  "createdAt": "2026-08-10T09:14:22.181Z"
}
```

| Field             | Type               | Description                                                                                    |
| ----------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| `id`              | uuid               | The tenant's id. UUIDv7                                                                        |
| `slug`            | string             | As supplied                                                                                    |
| `name`            | string             | As supplied                                                                                    |
| `status`          | enum               | `pending` \| `active` \| `suspended` \| `cancelled`. A successful provision is always `active` |
| `primaryHostname` | string             | Where the tenant is reachable: `<slug>.$PLATFORM_DOMAIN`, lowercased                           |
| `settings`        | object             | `{ timezone, locale }` — the values `tenant_settings` was seeded with                          |
| `createdAt`       | ISO 8601 timestamp | With offset                                                                                    |

**`201` means this call provisioned the tenant. `200` means it already existed and nothing
changed.** The body is identical either way — an idempotent operation that reported a
different resource on replay would not be idempotent — so the status code is how a script
tells the two apart.

### Errors

| Status | `code`              | Cause                                                                                                          |
| ------ | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| 400    | `validation_failed` | A field failed the contract. `details` names each one                                                          |
| 401    | `unauthenticated`   | Missing, malformed or wrong bearer token — or `PLATFORM_ADMIN_TOKEN` is unset                                  |
| 409    | `conflict`          | The platform hostname is claimed by another tenant, or the slug was provisioned concurrently by another writer |
| 500    | —                   | Anything else. A fault, logged as one, and nothing was written. **No envelope yet** — see below                |

A `409` on the hostname happens in practice when a tenant registered the same name as a
custom domain before anyone provisioned the slug that derives from it. A `409` on the slug
means a writer outside this service inserted it mid-transaction; retry, and the retry finds
that tenant through the idempotent path and answers `200`.

### Semantics

**Idempotent on `slug`.** A repeat call finds the tenant and returns it unchanged. It never
overwrites `name`, never reactivates a suspended tenant, and never resets settings — a rename
is `PATCH /api/v1/tenant` and a reactivation is TAR-36's, and silently doing either from a
provisioning endpoint is how a live tenant gets clobbered by a replayed script.

**Convergent.** A tenant missing its settings row or its platform domain — created by an
older version, or by a fixture — has the missing row added. Only what is missing is written.

**Atomic.** Everything runs in one transaction that first takes an advisory lock on the slug,
so two concurrent calls for the same slug serialise into one write. A failure anywhere rolls
the whole thing back: there is no half-provisioned tenant to clean up.

**The hostname is derived, never accepted from the caller.** `<slug>.$PLATFORM_DOMAIN`,
lowercased. A client-supplied hostname is how one tenant claims another's subdomain. The
domain row is written `kind = platform`, `is_primary = true` and already verified — it is
ours to issue under our own DNS zone, so there is nothing for the customer to prove, unlike
a custom domain.

**What provisioning does not create.** No users — inviting the first one is TAR-35. No
branding row — TAR-29 owns branding, including whether that row is written eagerly. No
subscription — TAR-37. Seeding a table another story owns would fix its defaults in the
wrong place.

**Isolation.** The route runs on `SystemPrisma`, the only client that can write `tenants`,
and is one of the five call sites TAR-39 permits for it. Every statement names the tenant it
just created; nothing reads or writes another tenant's rows. From the moment the transaction
commits, the new tenant's data is reachable only under its own `tenant_id` — every one of its
tables is RLS-protected and its rows match no other tenant's GUC. See
[Tenant-scoped data access](../guides/tenant-scoped-data-access.md).

---

## `POST /api/v1/admin/tenants/{slug}/deactivate`

Revoke a tenant's access while keeping its data. In force the moment it commits.

**Authentication:** platform admin token. Without it, `401 unauthenticated`.

This is the most destructive route on the admin surface short of deletion: the tenant's
agents stop reaching their data on their very next query, including through open sessions and
in-flight background jobs.

### Path parameters

| Field  | Type   | Required | Default | Description                                     |
| ------ | ------ | -------- | ------- | ----------------------------------------------- |
| `slug` | string | yes      | —       | The tenant's slug. Same pattern as provisioning |

The slug identifies the tenant rather than the id, for the same reason it identifies a
provisioning request: it is what an operator has in front of them, and unlike an id it cannot
quietly be a tenant they did not mean.

### Request body

| Field    | Type   | Required | Default | Description                                     |
| -------- | ------ | -------- | ------- | ----------------------------------------------- |
| `reason` | string | no       | —       | 1–500 characters. Free text for the audit trail |

The body may be omitted entirely. `reason` is optional because an operator acting on an
incident should not be blocked by a required field. It is recorded as given in
`audit_logs.metadata`, never rendered to the tenant, and never a place for a credential.

### Request

```bash
curl -X POST http://localhost:3001/api/v1/admin/tenants/acme/deactivate \
  -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Non-payment, ticket OPS-412"}'
```

### Response — `200 OK`

```json
{
  "id": "019f8c3d-4a2b-7c1e-9f00-2b6d4e8a1c53",
  "slug": "acme",
  "name": "Acme Ltd",
  "status": "suspended",
  "suspendedAt": "2026-08-10T11:02:47.006Z"
}
```

| Field         | Type                       | Description                                                                               |
| ------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `id`          | uuid                       | The tenant's id                                                                           |
| `slug`        | string                     | As supplied                                                                               |
| `name`        | string                     | The tenant's display name                                                                 |
| `status`      | enum                       | `pending` \| `active` \| `suspended` \| `cancelled`                                       |
| `suspendedAt` | ISO 8601 timestamp \| null | When deactivation revoked access, or `null` if the tenant reached this status another way |

**Always `200`**, whether this call deactivated the tenant or found it already deactivated.
Deactivation creates nothing, and a repeat call on an already-inaccessible tenant is a no-op
rather than a different outcome worth a different code.

`suspendedAt` is nullable because a tenant can reach a non-active status without going
through this endpoint — a `pending` row abandoned by a failed provision, a `cancelled` one
closed by TAR-36. It says when deactivation happened, not that it did.

### Errors

| Status | `code`              | Cause                                                                                                       |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| 400    | `validation_failed` | The slug is not a slug, or `reason` is longer than 500 characters                                           |
| 401    | `unauthenticated`   | Missing, malformed or wrong bearer token                                                                    |
| 404    | `not_found`         | No tenant carries this slug                                                                                 |
| 500    | —                   | Anything else. A fault, logged as one, and nothing was written. **No envelope yet** — see [Errors](#errors) |

The `404` is deliberate rather than a silent success: an operator who mistypes a slug during
an incident needs to know the tenant they meant is still serving traffic.

### Semantics

**Retention.** Two columns are written — `tenants.status` and `tenants.suspended_at` — and
nothing else. Nothing is deleted, anonymised or moved. Every contact, conversation, ticket
and message the tenant ever wrote stays exactly where it was and stays reachable through
`SystemPrisma` for support, billing, export and reactivation. Deletion is a separate
operation with a retention window, and it is not this one.

**The block is in the database, not in a guard.** `assert_tenant_active` is called by every
`TenantPrisma` statement on its way to setting the RLS GUC, so the block covers HTTP
handlers, queue workers, WebSocket handlers and raw SQL alike. The status is read inside the
transaction that is about to run rather than from a cache, so there is no window in which a
revoked tenant still reads, and no new route can forget to apply it.

**No other tenant is affected.** One row is written, identified by slug, and the gate reads
only the row the GUC names. A neighbour's queries do not change shape, cost or result.
`apps/api/src/tenancy/tenant-deactivation.int-spec.ts` is the regression proof.

**Idempotent.** A repeat call answers `200` and changes nothing — including `suspendedAt`,
which records when access was actually revoked and must survive a replayed script. A tenant
already `suspended` or `cancelled` is treated as already inaccessible.

**Audited.** The status write and an `audit_logs` row with action `tenant.deactivated` land
in one transaction, so an access revocation cannot exist without a record of it. Both
timestamps come from the database clock, read once, so two API instances a few seconds apart
cannot order the audit trail inconsistently with the row it describes. `actorUserId` is null:
the actor is the platform operator, who is never a user inside the tenant.

**Sessions are not revoked here.** TAR-35 owns `sessions` and login, and must refuse a
non-active tenant at login. Until it ships, a session issued before deactivation still
exists — but it reaches no data, because the database gate refuses every query behind it.

**Reactivation is not here.** `suspended → active` belongs to TAR-36's lifecycle state
machine; an endpoint that exists to take access away should not also be the one that gives it
back. Until it ships, an operator restores a tenant by setting `status` back to `active`
through the platform's own database access.

**A `pending` or `cancelled` tenant is blocked by the same gate.** Only `active` reaches data,
so a half-provisioned tenant is closed by the mechanism rather than by a second rule.

## Configuration

| Variable               | Required | Default         | Description                                                         |
| ---------------------- | -------- | --------------- | ------------------------------------------------------------------- |
| `PLATFORM_ADMIN_TOKEN` | no       | —               | Bearer credential for `/api/v1/admin/*`. Unset disables the surface |
| `PLATFORM_DOMAIN`      | no       | `app.localhost` | The zone platform subdomains are issued under                       |

Both are documented in `.env.example` and validated by
`apps/api/src/config/env.schema.ts` at boot.
