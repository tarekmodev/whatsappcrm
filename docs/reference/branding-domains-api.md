# Branding and custom domains API reference

Every endpoint a tenant's white-label appearance and its hostnames are set through, plus
the three platform-operator routes that attach a verified domain at the edge. Written for
engineers. The tenant admin's version is
[Put your own brand on the workspace](../guides/brand-your-workspace.md) and
[Serve the workspace from your own web address](../guides/set-up-a-custom-domain.md); the
operator's half — the Render dashboard steps, the wildcard certificate and what it costs —
is [the custom domains runbook](../runbooks/custom-domains.md).

Request and response shapes are defined in `packages/contracts/src/tenant.ts` and
`packages/contracts/src/admin.ts` and validated at the boundary. The tables below are
derived from those schemas, from `apps/api/src/tenancy/tenant.controller.ts`,
`apps/api/src/tenancy/domains/tenant-domains.controller.ts` and
`apps/api/src/tenancy/admin/admin-domains.controller.ts`, and from the error table in
`apps/api/src/tenancy/tenancy.http.ts`.

**What on this page is verified, and how.** The behaviour it describes — claim, verify,
promote, remove, upload, replace, the SVG refusal, the contested hostname and the isolation
properties at the end — was exercised against a live PostgreSQL on 2026-08-16:
`branding-domains-api.int-spec.ts` and `tenant-branding-domains.int-spec.ts`, 43 tests, both
suites passing.

> **TODO(author):** the `curl` calls and JSON bodies below were **not executed**. They are
> transcribed from the schemas, the controllers and the integration suite rather than
> captured from a running API, and the identifiers and timestamps in them are illustrative.
> Replay them against a local stack, paste the real responses, and drop this notice.

## The one thing to get right

⚠️ **Every route here is the same URL for every tenant. The tenant is the host.** There is
no tenant id, slug or hostname in any path, query or body on the tenant-facing surface, and
that is deliberate rather than incidental: `HostTenantGuard` resolves the tenant from the
request host and from nothing else, so there is no field for a caller to choose a tenant
with.

The consequence lands on anything that caches. **A cache keyed on the URL alone is a direct
cross-tenant leak** — one tenant's logo served under another tenant's brand — and it is the
highest-severity mistake available in this feature. The two unauthenticated routes say so on
the wire: both send `Vary: x-edge-host`, because on the hop that matters (the Next rewrite
in `apps/web/next.config.mjs`, where every tenant reaches one `API_BASE_URL`) the host
travels in that header and nowhere in the URL.

`x-edge-host` is honoured only when the request also presents `x-edge-auth`, the shared
secret the web tier and the API both hold. Without it the guard falls back to `Host`, never
to the forwarded value — a header any caller can set is a tenant any caller can choose. Both
header names are published as `TENANT_HOST_HEADER` and `EDGE_AUTH_HEADER`.

## Conventions

| Concern           | Rule                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| Base path         | `/api/v1`                                                                      |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                |
| Uploads           | `multipart/form-data`, one file part named `file` (`BRANDING_UPLOAD_FIELD`)    |
| Timestamps        | ISO 8601 with an explicit offset                                               |
| Success shape     | The resource itself. No envelope, except the `{ items }` lists                 |
| Error shape       | The envelope in [the admin API reference](admin-api.md#error-envelope), always |
| Authentication    | Session cookie, except the two `@Public()` routes and the operator routes      |
| `Idempotency-Key` | Not used. `PUT`, `PATCH` and `DELETE` are idempotent by shape                  |
| Rate limiting     | One control only — the 10-second floor between two checks of the same domain   |

### Permissions

Both are admin-only today: `ROLE_PERMISSIONS.admin` is the whole `PERMISSIONS` list, and
neither appears in the agent or supervisor sets.

| Permission       | Grants                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| `branding:write` | The product name, the support address, the two colours, the two assets  |
| `domain:write`   | Claim, verify, promote and remove a hostname — and read the DNS records |

They are separate on purpose. Control of DNS decides where every invite and password-reset
link in the tenant is addressed; choosing a logo colour does not. A supervisor may plausibly
be granted the second one day.

## Resources

### `TenantBranding`

Returned by `GET /tenant`, `GET /tenant/public`, `PATCH /tenant` and both asset writes.

**Always fully populated.** `BRANDING_DEFAULTS` fills whatever the tenant has not set, so a
client renders unconditionally and never branches on "has this tenant configured anything".

| Field          | Type                      | Notes                                                               |
| -------------- | ------------------------- | ------------------------------------------------------------------- |
| `productName`  | string, 1–60              | Defaults to `PLATFORM_PRODUCT_NAME`, then to `WhatsApp CRM`         |
| `primaryColor` | `#rrggbb`                 | Defaults to `#067a52`                                               |
| `accentColor`  | `#rrggbb`                 | Defaults to `#2e4a63`. Decorative only — never rendered behind text |
| `supportEmail` | string \| `null`          | `null` means the tenant has cleared it                              |
| `logo`         | `BrandingAsset` \| `null` | `null` until one is uploaded                                        |
| `favicon`      | `BrandingAsset` \| `null` |                                                                     |

The defaults live in `@whatsappcrm/contracts` rather than as `NOT NULL DEFAULT` columns.
A column default would bake the platform's own brand into every tenant's row and make "has
this tenant customised anything" unanswerable.

### `BrandingAsset`

| Field       | Type      | Notes                                                                   |
| ----------- | --------- | ----------------------------------------------------------------------- |
| `path`      | string    | `/api/v1/tenant/branding/logo?v=1755331200000` — relative, cache-busted |
| `mimeType`  | string    | The **sniffed** type, never the one the uploader declared               |
| `sizeBytes` | integer   |                                                                         |
| `updatedAt` | timestamp | `?v=` is this value as epoch milliseconds                               |

`path` is deliberately not an absolute URL. The same row is served under a platform
subdomain _and_ under a custom domain, so a stored origin would name whichever host existed
at write time and make the browser fetch it cross-origin — which the first-party cookie rule
forbids. Build it with `brandingAssetPath(kind, updatedAt)` rather than by hand.

### Asset limits

Published as `BRANDING_ASSET_LIMITS` so a client can refuse a file before spending the
upload. The server enforces the same numbers and sniffs the bytes.

| Kind      | Maximum | Accepted types                          |
| --------- | ------- | --------------------------------------- |
| `logo`    | 512 KB  | `image/png`, `image/jpeg`, `image/webp` |
| `favicon` | 64 KB   | `image/png`, `image/x-icon`             |

**No `image/svg+xml`, deliberately.** An SVG served same-origin executes script, and a
sanitiser is a security dependency to own forever.

### `TenantDomain`

| Field          | Type                           | Notes                                                                  |
| -------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `id`           | uuid                           | Names a **row**, never a tenant                                        |
| `hostname`     | string, 4–253                  | Lowercase punycode                                                     |
| `kind`         | `platform` \| `custom`         | The database enum value, unmapped                                      |
| `status`       | see below                      | **Derived from the timestamps, never stored**                          |
| `isPrimary`    | boolean                        | Where invite and password-reset links are addressed                    |
| `verifiedAt`   | timestamp \| `null`            |                                                                        |
| `activatedAt`  | timestamp \| `null`            | Set by the operator's activate route                                   |
| `verification` | `DomainVerification` \| `null` | `null` for `kind: 'platform'`, and for a caller without `domain:write` |
| `routing`      | `DomainRouting` \| `null`      | `null` for `platform`, once `live`, and without `domain:write`         |
| `createdAt`    | timestamp                      |                                                                        |

The status is computed in `tenant-domain.mapper.ts` from three columns rather than stored,
because a stored status is a second source of truth that disagrees with its own columns
after one failed write.

| `status`               | Means                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| `pending_verification` | Token issued, the TXT record has not been seen yet                         |
| `verified`             | Ownership proved. Resolves to the tenant — but the edge may not route it   |
| `live`                 | Attached at the edge with a certificate                                    |
| `expired`              | Unverified past `DOMAIN_VERIFICATION_TTL_DAYS`; the sweeper will remove it |

`verified` and `live` are separate states because two different parties hold them, and
neither can forge the other: a verified domain that is not attached receives no traffic, and
an attached domain that is not verified answers `tenant_not_found` on every route.

### `DomainVerification` and `DomainRouting`

Present only for a `custom` domain read by a caller holding `domain:write`.

| Field                            | Type                      | Example                                               |
| -------------------------------- | ------------------------- | ----------------------------------------------------- |
| `verification.recordType`        | `TXT`                     |                                                       |
| `verification.recordName`        | string                    | `_whatsappcrm-challenge.support.acme.com`             |
| `verification.recordValue`       | string                    | `whatsappcrm-domain-verification=<32 hex characters>` |
| `verification.lastCheckedAt`     | timestamp \| `null`       |                                                       |
| `verification.lastFailureReason` | see below \| `null`       |                                                       |
| `verification.expiresAt`         | timestamp                 | When an unverified claim is released                  |
| `routing.recordType`             | `CNAME` \| `ALIAS` \| `A` | Always `CNAME` today — only subdomains are claimable  |
| `routing.recordName`             | string                    | `support.acme.com`                                    |
| `routing.recordValue`            | string                    | `PLATFORM_EDGE_HOSTNAME`                              |

Build the two challenge strings with `domainChallengeRecordName()` and
`domainChallengeRecordValue()` — the console renders them and the verifier compares against
them, so a prefix that drifted on one side is a verification that can never pass.

**The token is returned to the tenant that owns the row, and that is not a leak.** It is
published in public DNS by design, it proves nothing except control of one hostname, and it
is scoped to one tenant. Row-level security keeps it out of everybody else's response, and
the audit trail deliberately does not record it.

| `lastFailureReason` | Means                                                     |
| ------------------- | --------------------------------------------------------- |
| `record_not_found`  | No TXT record at that name yet                            |
| `record_mismatch`   | A TXT record exists and its value is not the expected one |
| `lookup_failed`     | The nameservers could not be reached                      |
| `lookup_timeout`    | The lookup exceeded `DOMAIN_VERIFICATION_TIMEOUT_MS`      |

Four reasons rather than one, because "we cannot find it yet" and "there is a record and it
is wrong" send somebody to two completely different places.

## Branding

### `GET /api/v1/tenant/public`

The tenant's display name and appearance, for a caller with no session. This is what makes
the login screen themeable before anybody has signed in.

**Authentication.** None. `HostTenantGuard` still runs — the tenant comes from the host — so
an unresolvable host answers `404 tenant_not_found`.

It takes no parameters at all. A tenant identifier on this route would hand an anonymous
caller an enumeration oracle.

```bash
curl -sS https://acme.app.example.com/api/v1/tenant/public
```

```json
{
  "id": "019fed83-ebd1-774d-86e4-46137546a539",
  "name": "Acme Ltd",
  "branding": {
    "productName": "Acme Support",
    "primaryColor": "#0b6e4f",
    "accentColor": "#2e4a63",
    "supportEmail": "help@acme.com",
    "logo": {
      "path": "/api/v1/tenant/branding/logo?v=1755331200000",
      "mimeType": "image/png",
      "sizeBytes": 18244,
      "updatedAt": "2026-08-16T09:20:00.000Z"
    },
    "favicon": null
  }
}
```

| Status | Code               | Cause                                   |
| ------ | ------------------ | --------------------------------------- |
| `200`  | —                  |                                         |
| `404`  | `tenant_not_found` | The host matches no verified domain row |

No slug, no status, no domain list, no counts. Everything on this route is published to the
internet for every white-label host, so it carries the minimum an anonymous caller may see.

Sends `Vary: x-edge-host`.

### `GET /api/v1/tenant/branding/{kind}`

The bytes of the tenant's logo or favicon, for the same anonymous caller.

**Authentication.** None, and the same host-only tenant resolution. The route takes no
identifier and no storage key — the key is read off the resolved tenant's own row under
row-level security — so there is nothing to guess and no object reference to authorise.

| Parameter | In    | Type                | Required | Default | Notes                                   |
| --------- | ----- | ------------------- | -------- | ------- | --------------------------------------- |
| `kind`    | path  | `logo` \| `favicon` | yes      | —       |                                         |
| `v`       | query | string              | no       | —       | `logo_updated_at` in epoch milliseconds |

```bash
curl -sS -D - -o /dev/null \
  'https://acme.app.example.com/api/v1/tenant/branding/logo?v=1755331200000'
```

```text
HTTP/2 200
content-type: image/png
content-length: 18244
content-disposition: inline
x-content-type-options: nosniff
content-security-policy: default-src 'none'
etag: "logo-1755331200000"
vary: x-edge-host
cache-control: public, max-age=31536000, immutable
```

| Status | Code             | Cause                                               |
| ------ | ---------------- | --------------------------------------------------- |
| `200`  | —                | The bytes                                           |
| `404`  | `not_found`      | The tenant has never uploaded this kind             |
| `500`  | `internal_error` | The row names a key the object store cannot produce |

The headers are the security half, and they work as a set. `Content-Type` is the **sniffed**
type from the column, never the one the uploader declared; `nosniff` and `default-src 'none'`
stop a browser deciding the bytes are something executable on this origin; and
`Content-Disposition: inline` is safe only because of the two before it.

A request carrying the current `v` is answered `immutable` for a year, because a new upload
is a new URL. Anything else gets 60 seconds, so a stale link corrects itself quickly.

### `GET /api/v1/tenant`

The workspace as its own members see it.

**Authentication.** Session, any principal. Every signed-in user needs the product name and
the colours to render the shell, so gating this behind `tenant:settings` would refuse the
whole call to an agent who may read the workspace name.

```json
{
  "id": "019fed83-ebd1-774d-86e4-46137546a539",
  "name": "Acme Ltd",
  "slug": "acme",
  "status": "active",
  "branding": { "productName": "Acme Support", "primaryColor": "#0b6e4f", "…": "…" },
  "domains": [
    {
      "id": "019fee01-2a77-7c1e-9f30-6b21c0d4a118",
      "hostname": "acme.app.example.com",
      "kind": "platform",
      "status": "verified",
      "isPrimary": true,
      "verifiedAt": "2026-07-02T11:04:12.000Z",
      "activatedAt": null,
      "verification": null,
      "routing": null,
      "createdAt": "2026-07-02T11:04:12.000Z"
    }
  ],
  "trialEndsAt": null,
  "createdAt": "2026-07-02T11:04:12.000Z"
}
```

⚠️ **`verification` and `routing` are `null` on this route unless the caller holds
`domain:write`.** Same type either way — a client parses one shape; what changes is how much
of it is populated. An agent reading the shell must not be handed the pending challenge
tokens that `GET /tenant/domains` refuses them one path over.

### `PATCH /api/v1/tenant`

Rename the workspace, or change its appearance.

**Authentication.** Session, `branding:write`.

**Idempotency.** Replaying the same body leaves the same state. Only the keys present are
written — a form that shows one colour cannot blank the other by omitting it.

| Parameter               | In   | Type            | Required | Default | Notes                                             |
| ----------------------- | ---- | --------------- | -------- | ------- | ------------------------------------------------- |
| `name`                  | body | string, 1–120   | no       | —       | The tenant's legal-ish name, not the product name |
| `branding.productName`  | body | string, 1–60    | no       | —       |                                                   |
| `branding.primaryColor` | body | `#rrggbb`       | no       | —       |                                                   |
| `branding.accentColor`  | body | `#rrggbb`       | no       | —       |                                                   |
| `branding.supportEmail` | body | email \| `null` | no       | —       | Send `null` explicitly to clear it                |

The body cannot carry bytes. The logo and the favicon are set by the two routes below,
because a multipart body and a JSON patch are different request shapes and folding them
together makes both worse.

```bash
curl -sS -X PATCH https://acme.app.example.com/api/v1/tenant \
  -H 'Content-Type: application/json' \
  -b "$SESSION_COOKIE" \
  -d '{"branding":{"productName":"Acme Support","primaryColor":"#0b6e4f"}}'
```

Returns the full `TenantResponse`.

| Status | Code                | Cause                                                                  |
| ------ | ------------------- | ---------------------------------------------------------------------- |
| `200`  | —                   |                                                                        |
| `400`  | `validation_failed` | A colour that is not six hex digits, a name over 60, a malformed email |
| `403`  | `forbidden`         | The principal does not hold `branding:write`                           |

### `PUT /api/v1/tenant/branding/{kind}`

Replaces the logo or the favicon.

**Authentication.** Session, `branding:write`.

**Idempotency.** `PUT`, not `POST`: there is exactly one asset of each kind per tenant, and
uploading the same file twice leaves the same state.

| Parameter | In        | Type                | Required | Default | Notes                             |
| --------- | --------- | ------------------- | -------- | ------- | --------------------------------- |
| `kind`    | path      | `logo` \| `favicon` | yes      | —       |                                   |
| `file`    | multipart | binary              | yes      | —       | One part. The field name is fixed |

```bash
curl -sS -X PUT https://acme.app.example.com/api/v1/tenant/branding/logo \
  -b "$SESSION_COOKIE" \
  -F 'file=@acme-logo.png;type=image/png'
```

```json
{
  "productName": "Acme Support",
  "primaryColor": "#0b6e4f",
  "accentColor": "#2e4a63",
  "supportEmail": "help@acme.com",
  "logo": {
    "path": "/api/v1/tenant/branding/logo?v=1755334800000",
    "mimeType": "image/png",
    "sizeBytes": 18244,
    "updatedAt": "2026-08-16T10:20:00.000Z"
  },
  "favicon": null
}
```

| Status | Code                | Cause                                                         |
| ------ | ------------------- | ------------------------------------------------------------- |
| `200`  | —                   | The whole `TenantBranding`, with the new `path`               |
| `400`  | `validation_failed` | No `file` part, or bytes that are not an accepted image       |
| `403`  | `forbidden`         |                                                               |
| `413`  | `payload_too_large` | Past the per-kind ceiling. The message quotes the limit in KB |

**The type is sniffed from the first bytes, and the declared `Content-Type` is never
consulted.** A document uploaded as `image/png` is refused, and the sniffed value is what the
serve route later sets as the response's own type — so it could not have been served as
anything executable even if it had got through.

The write order is: validate, put the bytes under a **new** key, update the four columns,
then delete the previous key best-effort. A failure between the third and fourth steps leaves
a stray object that costs disk; the inverse order would leave a row pointing at a logo that
does not exist, which every agent in the tenant would see as a broken image.

### `DELETE /api/v1/tenant/branding/{kind}`

Removes one asset. The product name is rendered in its place.

**Authentication.** Session, `branding:write`.

**Idempotency.** A tenant with no such asset is a success, not a `404`.

| Status | Code        | Cause |
| ------ | ----------- | ----- |
| `204`  | —           |       |
| `403`  | `forbidden` |       |

## Custom domains

Everything under `/api/v1/tenant/domains` requires `domain:write`, list included. That is
deliberate rather than lazy: the settings screen is the only reader, DNS control is not the
same authority as reading a workspace name, and the list carries the challenge tokens.

No route here takes a tenant id, slug or hostname as a way of _selecting_ the tenant. `{id}`
names a row, and the lookup is scoped by row-level security to the tenant the host resolved
— so an id belonging to another tenant answers `not_found`, which is the same answer an id
belonging to nobody gets.

### `GET /api/v1/tenant/domains`

Every hostname this tenant holds, platform subdomain included, in full.

A plain `{ items }` envelope rather than a cursor page: the set is capped at
`MAX_CUSTOM_DOMAINS_PER_TENANT` (5) plus the platform subdomain, so there is nothing to page.
Ordered primary first, then oldest first.

```bash
curl -sS https://acme.app.example.com/api/v1/tenant/domains -b "$SESSION_COOKIE"
```

```json
{
  "items": [
    {
      "id": "019fee01-2a77-7c1e-9f30-6b21c0d4a118",
      "hostname": "acme.app.example.com",
      "kind": "platform",
      "status": "verified",
      "isPrimary": true,
      "verifiedAt": "2026-07-02T11:04:12.000Z",
      "activatedAt": null,
      "verification": null,
      "routing": null,
      "createdAt": "2026-07-02T11:04:12.000Z"
    },
    {
      "id": "019ff0b2-6c19-7a44-8d02-3f5e9a1b77c4",
      "hostname": "support.acme.com",
      "kind": "custom",
      "status": "pending_verification",
      "isPrimary": false,
      "verifiedAt": null,
      "activatedAt": null,
      "verification": {
        "recordType": "TXT",
        "recordName": "_whatsappcrm-challenge.support.acme.com",
        "recordValue": "whatsappcrm-domain-verification=3f9a1c7b28e04d5590ab6134fe27c8d1",
        "lastCheckedAt": "2026-08-16T09:31:07.000Z",
        "lastFailureReason": "record_not_found",
        "expiresAt": "2026-08-23T09:28:44.000Z"
      },
      "routing": {
        "recordType": "CNAME",
        "recordName": "support.acme.com",
        "recordValue": "whatsappcrm-web-prod.onrender.com"
      },
      "createdAt": "2026-08-16T09:28:44.000Z"
    }
  ]
}
```

The platform subdomain is in the list rather than filtered out: it is the address that keeps
working while a custom domain is being set up, and a screen that hides it cannot explain why
the tenant is still reachable after removing everything else.

### `POST /api/v1/tenant/domains`

Claims a hostname and issues the DNS challenge.

**Idempotency.** `201` when this call created the claim, `200` when the tenant already held
it — a double-submitted form is not a conflict, and a client re-running the call needs to
know whether it just created something. A claim of this tenant's own that has **lapsed** is
re-issued with a fresh token and a fresh clock.

| Parameter  | In   | Type          | Required | Default | Notes                                    |
| ---------- | ---- | ------------- | -------- | ------- | ---------------------------------------- |
| `hostname` | body | string, 4–253 | yes      | —       | Trimmed and lowercased before validation |

`hostname` must be punycode (A-label), carry no port, no trailing dot and no scheme, not be
an IPv4 literal, and not end in `.local`, `.internal` or `.localhost`. Non-ASCII is **refused
with an explicit message rather than silently converted**: a homograph accepted quietly is a
phishing host the platform would then issue a certificate for.

Two further rules are applied server-side because they depend on deployment configuration
the browser is not given:

- **A hostname under `PLATFORM_DOMAIN` is refused.** That zone is ours to issue, and nobody
  may claim one however privileged.
- **An apex domain is refused.** A root domain cannot take a `CNAME`, so the routing record
  the claim would hand back is one the registrar will not accept. The check counts labels —
  fewer than three is treated as apex — which refuses the common form without carrying a
  Public Suffix List. `acme.co.uk` therefore passes and will never route; that limit is named
  in the runbook's Open section.

```bash
curl -sS -X POST https://acme.app.example.com/api/v1/tenant/domains \
  -H 'Content-Type: application/json' \
  -b "$SESSION_COOKIE" \
  -d '{"hostname":"support.acme.com"}'
```

Returns one `TenantDomain`, the second item in the list above.

| Status | Code                  | Cause                                                                 |
| ------ | --------------------- | --------------------------------------------------------------------- |
| `201`  | —                     | The claim was created                                                 |
| `200`  | —                     | This tenant already held it                                           |
| `400`  | `validation_failed`   | Schema refusal, a hostname under `PLATFORM_DOMAIN`, or an apex domain |
| `402`  | `plan_limit_exceeded` | Already holding 5 custom domains                                      |
| `403`  | `forbidden`           | The principal does not hold `domain:write`                            |
| `403`  | `feature_not_in_plan` | This environment has no `PLATFORM_EDGE_HOSTNAME`                      |
| `409`  | `conflict`            | Another tenant holds the hostname                                     |

**`409`, not `403`, and the message names nothing about the holder.** `hostname citext
UNIQUE` is global and enforced _below_ row-level security, so the conflicting row is
unreadable from the claimant's scope — the service never reads it back, because it could not,
and a message naming the holder would leak one tenant to another.

`feature_not_in_plan` for a missing edge hostname is the closest published code for "this
deployment does not offer custom domains". It is a `403` rather than a `500` because nothing
is broken: the routing infrastructure has simply not been configured here. Refusing the claim
beats handing back a routing record with a blank target, which would have the tenant publish
a CNAME to nothing and wait for a verification that cannot arrive.

### `POST /api/v1/tenant/domains/{id}/verify`

Checks the DNS challenge now.

**Always `200`, including when the record is not there yet.** Nothing went wrong with the
_request_, and "not verified yet" is a state on the resource the response already carries —
`status` and `verification.lastFailureReason` say which of the four reasons it was. An error
envelope here would make a settings screen render a failure banner for the ordinary case of
DNS not having propagated.

Verifying a `platform` domain, or one already verified, is a no-op that returns the row
unchanged. A settings screen may reasonably offer the same button on every row, and
re-checking a verified domain would create a path for one DNS blip to un-verify a live one.

```bash
curl -sS -X POST \
  https://acme.app.example.com/api/v1/tenant/domains/019ff0b2-6c19-7a44-8d02-3f5e9a1b77c4/verify \
  -b "$SESSION_COOKIE"
```

| Status | Code           | Cause                                                        |
| ------ | -------------- | ------------------------------------------------------------ |
| `200`  | —              | Checked. Read `status` and `verification.lastFailureReason`  |
| `403`  | `forbidden`    |                                                              |
| `404`  | `not_found`    | No such row in this tenant                                   |
| `429`  | `rate_limited` | Less than 10 seconds since the last check of **this** domain |

The throttle is durable — `verification_last_checked_at` on the row, not a counter in a cache
— so it holds across replicas and across a restart. Combined with the five-domain cap it
bounds a tenant at 30 lookups a minute, which is what matters: each check is an outbound DNS
query to a nameserver the _tenant_ nominated, so an unbounded one is a small amplification
vector pointed wherever they like.

The message names the wait in seconds. **There is no `Retry-After` header** — read the
message, or retry after 10 seconds.

> TAR-416 also specifies 20 checks per hour per tenant. That one is **not built**: it needs a
> shared sliding-window counter, which means Redis, and failing open on an unreachable Redis
> would leave the per-domain floor as the only real control anyway.

Verification also happens without anyone pressing anything. `DomainVerificationSweeper` is a
BullMQ repeatable job that re-checks pending claims every
`DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS` with per-claim backoff (1 minute, then 5, 15, 60, and
6 hours as the ceiling), and deletes claims past their window. DNS propagation is minutes to
hours; a flow that only verified on demand would leave the customer with "it did not work,
try again later".

### `POST /api/v1/tenant/domains/{id}/primary`

Makes a domain the address the platform mails invite and password-reset links to.

```bash
curl -sS -X POST \
  https://acme.app.example.com/api/v1/tenant/domains/019ff0b2-6c19-7a44-8d02-3f5e9a1b77c4/primary \
  -b "$SESSION_COOKIE"
```

| Status | Code        | Cause                                                       |
| ------ | ----------- | ----------------------------------------------------------- |
| `200`  | —           | Already primary is also `200`                               |
| `403`  | `forbidden` |                                                             |
| `404`  | `not_found` |                                                             |
| `409`  | `conflict`  | Not verified, or verified and not yet activated at the edge |

Both refusals are `409` and both matter, for different reasons:

- **Not verified** is security. Pointing the primary at a hostname nobody has proved control
  of mails a live token to a host the tenant does not own.
- **Verified but not activated** is availability. Attaching the hostname at the edge is a
  manual operator step and can sit in the queue for hours. Promoting inside that window aims
  every invite and reset link at a host with no route and no certificate — and nothing fails
  loudly: the mail sends, and nobody in the tenant can accept an invitation or reset a
  password until an operator gets to it.

Activation is asked of a `custom` domain only. A platform subdomain is served by the same
edge as every other tenant's, so it is deliverable the moment it exists — requiring
activation would leave the tenant's fallback address permanently unpromotable.

### `DELETE /api/v1/tenant/domains/{id}`

Releases a custom domain. **It stops resolving immediately** — the row is what host
resolution reads, so removing it is the whole revocation. Detaching at the edge and cleaning
up DNS are the operator's and the tenant's respectively; neither is needed for the domain to
stop serving.

Removing the current primary moves primary back to the platform subdomain in the same
transaction.

| Status | Code        | Cause                                                             |
| ------ | ----------- | ----------------------------------------------------------------- |
| `204`  | —           |                                                                   |
| `403`  | `forbidden` | A `platform` domain. It is the tenant's floor and never removable |
| `404`  | `not_found` |                                                                   |

A tenant whose only hostname is gone is unreachable and cannot be recovered without operator
help, which is why the platform subdomain is refused outright rather than merely discouraged.

## Platform operator routes

Three routes under `/api/v1/admin`, behind `PlatformAdminGuard` and outside the tenant
request pipeline — the operator is not a user in any tenant, and the queue spans all of them.
Authentication is the bearer token described in
[the platform admin API reference](admin-api.md#authentication).

The activate and deactivate pair names one tenant by slug and enters that tenant's scope
before touching a row, so row-level security still bounds the write. A mistyped slug is a
`404` rather than a silent no-op against nothing.

### `GET /api/v1/admin/domains`

The activation queue: what has been verified and is waiting to be attached. Custom domains
only, up to 200 at a time.

| Parameter | In    | Type                 | Required | Default    | Notes                              |
| --------- | ----- | -------------------- | -------- | ---------- | ---------------------------------- |
| `status`  | query | `verified` \| `live` | no       | `verified` | `live` answers "what did I attach" |

```bash
curl -sS 'https://whatsappcrm-api-prod.onrender.com/api/v1/admin/domains?status=verified' \
  -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN"
```

```json
{
  "items": [
    {
      "tenantSlug": "acme",
      "tenantName": "Acme Ltd",
      "hostname": "support.acme.com",
      "verifiedAt": "2026-08-16T09:41:55.000Z",
      "activatedAt": null
    }
  ]
}
```

It names the tenant because an operator has to attach the hostname to the right
environment's web service and needs to know whose it is. Nothing else about the tenant is
exposed.

⚠️ **Watch this queue.** A verified domain sits waiting until somebody looks, and "verified
more than 24 hours ago with no activation" is the failure mode this feature actually has. A
daily digest, not a page.

### `POST /api/v1/admin/tenants/{slug}/domains/{hostname}/activate`

Records that the hostname is attached at the edge with a certificate. This is what flips the
tenant's console from `verified` to `live` and what takes the row off the queue above.

It records rather than performs: attaching the hostname itself is a Render dashboard action.
See [the runbook](../runbooks/custom-domains.md#per-tenant-attaching-a-verified-custom-domain)
for the full sequence and the environment check that has no automated backstop.

**Idempotency.** Activating an already-activated domain is a no-op answering `204`, not a
conflict the operator has to interpret mid-incident.

| Status | Code              | Cause                                                                      |
| ------ | ----------------- | -------------------------------------------------------------------------- |
| `204`  | —                 |                                                                            |
| `401`  | `unauthenticated` | Missing or wrong bearer token                                              |
| `404`  | `not_found`       | No such slug, or the hostname is absent, another tenant's, or not verified |

The last row is one answer for three cases on purpose. The operator is authorised for every
tenant, but the slug in the path is the tenant they **named** — silently acting on a different
one is how a domain gets attached to the wrong environment's data.

### `POST /api/v1/admin/tenants/{slug}/domains/{hostname}/deactivate`

The inverse, once the hostname has been removed from the web service. Same statuses.

## Configuration

| Variable                                | Required | Default         | What it decides                                                                       |
| --------------------------------------- | -------- | --------------- | ------------------------------------------------------------------------------------- |
| `PLATFORM_DOMAIN`                       | yes      | `app.localhost` | The zone platform subdomains are issued under, and the zone no tenant may claim under |
| `PLATFORM_EDGE_HOSTNAME`                | no       | —               | The CNAME target handed to a claimant. **Absent means claims are refused**            |
| `PLATFORM_PRODUCT_NAME`                 | no       | `WhatsApp CRM`  | What a tenant that has set no product name is called                                  |
| `DOMAIN_VERIFICATION_TTL_DAYS`          | no       | `7`             | How long an unverified claim holds its hostname                                       |
| `DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS` | no       | `900000`        | How often pending claims are re-checked and lapsed ones released                      |
| `DOMAIN_VERIFICATION_TIMEOUT_MS`        | no       | `3000`          | Per-lookup timeout, recorded as `lookup_timeout`                                      |

None of these is a secret. `PLATFORM_EDGE_HOSTNAME` is published to every tenant that adds a
domain, and `PLATFORM_PRODUCT_NAME` to every unauthenticated caller.

⚠️ **Changing `PLATFORM_EDGE_HOSTNAME` in production invalidates the CNAME every existing
tenant has already published.** Treat it as fixed once the first custom domain is live.

An unverified claim reserves a globally unique hostname, which is why it expires at all:
without a window, one tenant typing a competitor's domain would hold it forever. Reclaim
latency is one sweep interval on top of the TTL — a tenant told `conflict` on a hostname
whose claim has just lapsed succeeds on retry within that window. That is documented
behaviour, not a bug: deleting another tenant's row inline at claim time would need
`SystemPrisma` on a request path.

## Isolation

The properties `branding-domains-api.int-spec.ts` asserts against a real database, rather
than the ones a unit test can show:

- Branding written by one tenant is what that tenant's host serves, and another tenant's host
  never serves it — including the asset bytes, which are namespaced
  `tenants/<tenant-id>/branding/<key>` in object storage.
- A hostname belongs to exactly one tenant. The loser of a race gets `conflict` and learns
  nothing about the winner — not its id, not its slug.
- An unverified custom domain resolves to **nothing**, so a claim alone cannot be used to
  discover which hostnames are taken; removing a verified one stops it resolving on the next
  request rather than when an operator gets to it.
- One tenant never sees another's verification token.

Two rules hold everywhere on this surface and are worth restating because every one of the
above depends on them: **no tenant identity is ever taken from client-supplied input**, and
**every statement goes through `TenantPrisma`**, so `tenant_isolation` supplies and enforces
`tenant_id`. See [the tenant isolation contract](tenancy.md).
