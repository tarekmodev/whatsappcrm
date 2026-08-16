# Public signup API reference

The four routes a visitor with no account and no tenant can reach (TAR-405, implementing
[ADR 0009](../architecture/0009-tenant-lifecycle-and-self-signup.md) decision 3). Written for
engineers building a signup form against this API.

**These are the only routes in the product that are both outside tenancy and unauthenticated.**
Everything about their shape follows from that: no field carries authority, nothing identifies a
tenant, and the one thing that does grant authority — the verification token — is generated
server-side and never appears in a request a client composes.

Request and response shapes are `packages/contracts/src/signup.ts`, validated at the boundary;
the tables below derive from those schemas and from `apps/api/src/signup/`. What happens to the
tenant _after_ signup is [the tenant lifecycle reference](tenant-lifecycle.md).

## Conventions

| Concern           | Rule                                                                                |
| ----------------- | ----------------------------------------------------------------------------------- |
| Base path         | `/api/v1`                                                                           |
| Host              | The **platform** host, not a tenant subdomain. There is no tenant yet               |
| Authentication    | None. That is the premise                                                           |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                     |
| Timestamps        | ISO 8601 with an explicit offset                                                    |
| Error shape       | The envelope in [the admin API reference](admin-api.md#error-envelope)              |
| Rate limiting     | Enforced here — see [Rate limits](#rate-limits). `rate_limited` on any of the three |
| `Idempotency-Key` | Not used. `verify` is idempotent through the token's compare-and-set instead        |

### Signup can be switched off

`SIGNUP_ENABLED` (boolean, default `true`) turns the whole surface off for a deployment that
provisions tenants through the operator path instead. When it is `false`, **all four routes
answer `404 not_found`** — never `403`. A 403 says "this exists, you may not use it", which is
exactly what a reseller who turned self-serve off does not want announced to anybody who probes.

### Why signup is two calls

`POST /signup` writes one `tenant_signups` row and sends one email. Nothing is provisioned until
`POST /signup/verify` presents the token.

Provisioning on the first call would let anything that can POST a form burn platform subdomains
— `tenant_domains.hostname` is globally unique, so a squatted slug is permanently unavailable to
the customer who wanted it — and would fill `tenants` with a row per bot.

That creates the problem it solves: the form has to tell somebody their slug is taken _before_
they go and check their inbox, or verification fails at the last step with the one error they
cannot fix without starting over. So a pending signup holds a **soft reservation** on the slug it
asked for, and `GET /signup/slug-available` is what the form asks before it submits.

### What an anonymous caller is told, and what they are not

The slug is the one fact this surface confirms. That is accepted deliberately: a platform
subdomain is public DNS, so the answer is already available to anyone who looks it up.

**An email address is never confirmed.** `POST /signup` and `POST /signup/resend` answer the same
`202` whether the address is new, already has a signup in flight, or already runs a tenant. There
is no "that address already signed up" error, and adding one would turn the form into a way to
ask whether a person uses the product. Identity is tenant-scoped (`UNIQUE (tenant_id, email)`),
so the same address signing up twice is two unrelated accounts and there is no global answer to
leak in the first place.

## Endpoints

### `POST /api/v1/signup`

Records a signup and mails the verification link. Provisions nothing.

**Authentication.** None.

**Idempotency.** Not idempotent. A second call for the same address writes a second row and
sends a second link, bounded by the rate limits below. A second call for the same **slug** while
the first is unconsumed and unexpired is refused with `conflict`.

| Parameter    | In   | Type                       | Required | Default             | Notes                                                           |
| ------------ | ---- | -------------------------- | -------- | ------------------- | --------------------------------------------------------------- |
| `email`      | body | string, email              | yes      | —                   | Becomes the first admin's address. Stored `citext`              |
| `password`   | body | string, 12–256 chars       | yes      | —                   | Hashed with argon2id before it is stored — see below            |
| `adminName`  | body | string, 1–120 chars        | yes      | —                   | The first admin's display name                                  |
| `tenantName` | body | string, 1–120 chars        | yes      | —                   | The workspace's display name                                    |
| `slug`       | body | string, 3–40 chars         | yes      | —                   | `^[a-z0-9][a-z0-9-]*[a-z0-9]$`. Becomes the platform subdomain  |
| `timezone`   | body | IANA time zone name        | no       | `tenant_settings`'s | e.g. `Asia/Riyadh`. Seeds the tenant's settings on provisioning |
| `locale`     | body | BCP 47, e.g. `en`, `en-GB` | no       | `tenant_settings`'s | Seeds the tenant's settings on provisioning                     |

`slug` is the customer's choice and is **not** derived from `tenantName`: a derived slug is one
the customer cannot correct, and it would collide far more often than one they picked.

```bash
curl -X POST https://api.example.com/api/v1/signup \
  -H 'Content-Type: application/json' \
  -d '{
        "email": "hana@acme.example.com",
        "password": "correct-horse-battery",
        "adminName": "Hana Al-Rashid",
        "tenantName": "Acme Ltd",
        "slug": "acme",
        "timezone": "Asia/Riyadh",
        "locale": "en-GB"
      }'
```

```json
{ "email": "hana@acme.example.com", "expiresAt": "2026-08-17T09:14:22.000+03:00" }
```

`202`, not `201`: nothing has been created that the caller can go and look at. The pending row is
deliberately not addressable — a resource the caller could `GET` would be an oracle for which
addresses have a signup in flight.

The response is deliberately thin. It names the address the mail went to and when the link dies,
and nothing else. In particular it does not say whether this was a new signup or a repeat, and it
carries no id.

| Status | Code                | Cause                                                       |
| ------ | ------------------- | ----------------------------------------------------------- |
| `202`  | —                   | Recorded, mail sent                                         |
| `400`  | `validation_failed` | A field failed its schema. `details` names the path         |
| `404`  | `not_found`         | `SIGNUP_ENABLED=false`                                      |
| `409`  | `conflict`          | The slug is taken by a tenant or held by a live reservation |
| `429`  | `rate_limited`      | `signupsPerIpPerHour` or `signupsPerEmailPerDay` spent      |

**The password is taken here, not on the verify page**, and that is a decision rather than a
convenience: a verify page that asks for a password is a page an attacker who intercepted the
link can _complete_, whereas one that only confirms is not. It is hashed with argon2id at the
same cost parameters as `users.password_hash` before it is stored, and an unconsumed signup is
removed by the expiry sweep, so an abandoned one leaves no credential behind.

### `POST /api/v1/signup/verify`

Spends the token: provisions the tenant, makes the signup user its first admin, and signs them
in. One transaction — a failure at any step leaves no tenant and a token that still works.

**Authentication.** The token from the emailed link. It is the credential.

**Idempotency.** Single-use by compare-and-set (`WHERE consumed_at IS NULL AND expires_at >
now()`), so two clicks on one link provision one tenant and the second answers `410`.

| Parameter | In   | Type   | Required | Default | Notes                                         |
| --------- | ---- | ------ | -------- | ------- | --------------------------------------------- |
| `token`   | body | string | yes      | —       | The opaque token from the link's URL fragment |

```bash
curl -X POST https://api.example.com/api/v1/signup/verify \
  -H 'Content-Type: application/json' \
  -d '{"token":"<token from the link fragment>"}'
```

```json
{
  "tenant": {
    "id": "019fed83-ebd1-774d-86e4-46137546a539",
    "slug": "acme",
    "name": "Acme Ltd",
    "status": "trialing",
    "primaryHostname": "acme.app.example.com",
    "settings": { "timezone": "Asia/Riyadh", "locale": "en-GB" },
    "createdAt": "2026-08-16T09:14:22.000+03:00"
  },
  "user": {
    "userId": "019fed83-ec02-7f1a-9a55-2b71c0d4e8a1",
    "tenantId": "019fed83-ebd1-774d-86e4-46137546a539",
    "email": "hana@acme.example.com",
    "displayName": "Hana Al-Rashid",
    "role": "admin",
    "permissions": ["..."],
    "teamIds": [],
    "sessionId": "019fed83-ec03-7c44-b0d2-9f3a6e15c7b8",
    "expiresAt": "2026-08-30T09:14:22.000+03:00"
  },
  "primaryHostname": "acme.app.example.com"
}
```

`201`, unlike login's `200`: this genuinely creates a resource the caller did not have. The
session token leaves in a `Set-Cookie` header and appears in no response field and no log line.

| Status | Code                | Cause                                                              |
| ------ | ------------------- | ------------------------------------------------------------------ |
| `201`  | —                   | Tenant provisioned, admin created, session issued                  |
| `400`  | `validation_failed` | `token` absent or empty                                            |
| `404`  | `not_found`         | `SIGNUP_ENABLED=false`                                             |
| `410`  | `token_invalid`     | Unknown, expired or already spent. `details[0].message` says which |

`token_invalid` carries the reason as a detail entry — `unknown`, `expired` or `consumed` — so
the verify screen can word itself and a support engineer can tell a lapsed link from a replayed
one. All three answer the same code: the token is 256 bits of uniform entropy, so anybody able to
ask already holds it.

**The cookie is set on the platform host**, which is where this request arrived, while
`primaryHostname` in the body is the tenant's own subdomain. The client redirects there; signing
in on the tenant host is the console's job, and it is why the hostname is published here.

**The tenant comes back as `ProvisionedTenantResponse`, not `TenantResponse`.** `TenantResponse`
requires a `branding` object and provisioning writes no `tenant_branding` row on purpose — TAR-29
owns branding, including whether that row is written eagerly. The console reads branding from
`GET /tenant` once it is on the tenant host.

What provisioning writes, and the state it leaves the tenant in, is in
[the lifecycle reference](tenant-lifecycle.md#provisioning-two-paths-two-starting-states).

### `POST /api/v1/signup/resend`

Re-sends the verification link for a signup that is still outstanding.

**Authentication.** None.

**Idempotency.** Not idempotent — each call rotates the token and increments a counter. Always
answers `202`.

| Parameter | In   | Type          | Required | Default | Notes                             |
| --------- | ---- | ------------- | -------- | ------- | --------------------------------- |
| `email`   | body | string, email | yes      | —       | The only field. See below for why |

```bash
curl -X POST https://api.example.com/api/v1/signup/resend \
  -H 'Content-Type: application/json' \
  -d '{"email":"hana@acme.example.com"}'
```

```json
{ "email": "hana@acme.example.com", "expiresAt": "2026-08-17T09:14:22.000+03:00" }
```

| Status | Code                | Cause                                        |
| ------ | ------------------- | -------------------------------------------- |
| `202`  | —                   | Whether or not there was anything to resend  |
| `400`  | `validation_failed` | `email` absent or not an address             |
| `404`  | `not_found`         | `SIGNUP_ENABLED=false`                       |
| `429`  | `rate_limited`      | The per-address or per-email window is spent |

Four behaviours a caller will otherwise discover by experiment:

- **The address is the only field.** The pending signup already holds everything else, and
  accepting any of it again would let a caller who knows an address change the tenant name or
  slug it was signed up with.
- **The old link stops working.** The row holds one token hash, so rotating it revokes the
  previous link. Somebody asking for a resend usually cannot find the first mail, and leaving
  both live would widen the window for a link that leaked in transit.
- **`expiresAt` does not move.** The deadline belongs to the signup, not to the last email about
  it. Extending it on every resend would make the window renewable at one request a day, and the
  slug reservation rides on that column. A resend near the deadline therefore sends a link with
  little life left; the way to get another full window is to sign up again, which the expiry
  sweep has by then made possible.
- **An address with nothing outstanding gets `202` and no mail**, with an `expiresAt` computed as
  though a signup had started now. The alternative is an oracle for which addresses have signed
  up. Past `resendsPerSignup` the answer is the same, for the same reason.

### `GET /api/v1/signup/slug-available`

Whether a slug can be claimed right now — checked against provisioned tenants **and** live
reservations, so the form does not offer a name that a signup sitting in somebody else's inbox is
about to take.

**Authentication.** None.

| Parameter | In    | Type               | Required | Default | Notes                        |
| --------- | ----- | ------------------ | -------- | ------- | ---------------------------- |
| `slug`    | query | string, 3–40 chars | yes      | —       | Same shape as `POST /signup` |

```bash
curl 'https://api.example.com/api/v1/signup/slug-available?slug=acme'
```

```json
{ "slug": "acme", "available": false }
```

| Status | Code                | Cause                            |
| ------ | ------------------- | -------------------------------- |
| `200`  | —                   |                                  |
| `400`  | `validation_failed` | `slug` absent or malformed       |
| `404`  | `not_found`         | `SIGNUP_ENABLED=false`           |
| `429`  | `rate_limited`      | `slugChecksPerIpPerMinute` spent |

This is an enumeration oracle for which tenants exist, and it is accepted once, here: the
platform subdomain is a public DNS name, so anybody who wants the list can get it from DNS.

The check is a courtesy that can lose its race — the partial unique index
`tenant_signups_slug_reserved` is the authority, and `POST /signup` re-reports a slug taken
between the check and the submit as `conflict`.

## The verification link

```text
https://{platformHost}/verify#token={token}
```

Three properties, all of them 0005's invite and password-reset mechanism reused unchanged:

- **The platform host, not a tenant host.** At that moment there is no tenant and therefore no
  tenant hostname. The mailer assembles the URL from `linkPath` plus `token`;
  `OutboundEmail.tenantId` is `null`, which is what tells the adapter to use the platform host.
- **The token is in the fragment.** Browsers never send a fragment, so it exists only in the
  address bar until client-side code reads it and POSTs it. The verify page should clear it with
  `history.replaceState` after reading.
- **256 bits from `crypto.randomBytes`, SHA-256 at rest.** The plaintext token exists in the
  email and nowhere else; a database leak yields no usable link.

> **TODO(author):** the console has no `/verify` page and no `/signup` page —
> `apps/web/app/(auth)/` holds `login`, `invite`, `forgot-password` and `reset-password` only.
> Which story owns the two screens this API needs? Until one ships, the four routes are reachable
> by an API client and by nothing a customer can use.

## Rate limits

`SIGNUP_POLICY` in `packages/contracts/src/signup.ts`. Every one of these answers
`429 rate_limited` with the same message, so a refusal cannot be read as "that address is known".

| Key                        | Value | Bounds                                                   | Enforced in            |
| -------------------------- | ----- | -------------------------------------------------------- | ---------------------- |
| `signupsPerIpPerHour`      | 5     | One machine minting signups or enumerating slugs         | Redis **and** Postgres |
| `signupsPerEmailPerDay`    | 3     | Mailbox flooding through the form                        | Redis **and** Postgres |
| `slugChecksPerIpPerMinute` | 30    | The form checking as the user types. A debounce backstop | Redis only             |
| `resendsPerSignup`         | 3     | Links re-sent for one pending signup                     | Postgres only          |

**The Redis windows fail open**, matching `LoginThrottleService`: failing closed would turn a
cache outage into "nobody can sign up". What makes that safe is the durable layer — the two
signup-creating limits are counted against `tenant_signups` rows on every request, in the same
Postgres the endpoint already needs. An outage loosens the limits to whatever the durable layer
says; it does not remove them.

The two layers count different things on purpose. Redis counts **attempts**, including ones that
never became a row — a refused slug, a rejected body — so it catches a caller hammering the
endpoint without ever succeeding. Postgres counts **rows created**.

`POST /signup/resend` needs its own answer because it creates no row for those counts to see, so
its ceiling lives on `tenant_signups.resend_count` and is carried in the `UPDATE`'s own predicate
— the check and the increment are one statement, so two simultaneous resends cannot both pass it.
Between the two, verification mail to one address is capped at `signupsPerEmailPerDay × (1 +
resendsPerSignup)` a day with no cache involved.

`slugChecksPerIpPerMinute` is Redis-only and deliberately: an availability check creates no row,
so there is nothing durable to count, and losing the limit during an outage costs nothing on an
answer already public in DNS.

Addresses are hashed into the Redis keys rather than written into them. Keys turn up in `MONITOR`
output, slow-log entries and memory dumps, and an unverified email address in one is a personal
detail nobody has confirmed.

## Storage

`tenant_signups`, one of the four tables with no tenant scoping — see
[the tenant isolation contract](tenancy.md#the-five-tables-with-no-rls-policy). A policy needs a
tenant to compare against and there is none: at insert the tenant has not been provisioned and
the caller is anonymous. `whatsappcrm_app` is granted nothing on the table at all, so the
**grant** rather than a policy is the enforcement, and every statement runs through
`SystemPrisma`.

Two indexes carry the design and neither is expressible in Prisma:

```sql
CREATE UNIQUE INDEX tenant_signups_slug_reserved
  ON tenant_signups (desired_slug) WHERE consumed_at IS NULL;
CREATE INDEX tenant_signups_expires_at_idx
  ON tenant_signups (expires_at) WHERE consumed_at IS NULL;
```

The reservation predicate **cannot** also say `AND expires_at > now()` — an index predicate must
be `IMMUTABLE` — so an abandoned signup holds its slug until something deletes it. That something
is `POST /signup` itself: it deletes expired unconsumed rows for the slug being claimed inside
its own transaction, before inserting. Same trap and same answer as `invites_one_live_per_email`.

Columns are in `apps/api/prisma/schema.prisma` (`model TenantSignup`) and documented there; this
page does not transcribe them.

## Verification

Every request and response body on this page is derived from
`packages/contracts/src/signup.ts`, `apps/api/src/signup/signup.controller.ts` and
`apps/api/src/signup/tenant-signup.service.ts`, and matches
`apps/api/src/signup/signup-flow.int-spec.ts`.

> **TODO(author):** the curl examples are **not run**. They need a platform host with
> `SIGNUP_ENABLED=true` and a working mailer to complete the `verify` step, which this workspace
> does not have. The shapes are derived from the schemas and the integration suite; the exact
> wire output has not been observed.
