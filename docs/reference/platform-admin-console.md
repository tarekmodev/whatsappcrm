# Platform admin console

The operator console at `/admin` in `apps/web`: what it does, what it cannot do, and why the
second list is longer than anyone reading the design reference expects.

Written for engineers, and for the platform operator who has to work out whether a question
they have can be answered from a browser or needs psql. It is the console half of
[the platform admin API reference](admin-api.md), which documents the endpoints behind it.

Everything here is operated by us, never by a customer. Nothing on this surface is reachable
by a tenant's own users under any role, and none of it goes through the session and RBAC
model that TAR-35 and TAR-22 build for tenant-facing routes.

## Getting in

There is no operator account. `PlatformAdminGuard` authenticates a **shared bearer token**
from `PLATFORM_ADMIN_TOKEN`, whose entries are `label:secret` pairs — the operator is not a
user inside any tenant, so there is nothing for a session lookup or a per-tenant role to
resolve them against, and provisioning has to work before the first tenant exists.

So "signing in" is presenting a token:

1. `/admin/sign-in` takes the secret half of one entry — the part after the `label:`.
2. The console verifies it against `GET /api/v1/admin/domains`, the only read on the whole
   admin surface that names no tenant, and stores it on success.
3. It is kept in an `httpOnly`, `SameSite=Strict` cookie scoped to `Path=/admin`, and read
   back **on the server** for every call. No component receives it and no client bundle
   contains it.

The path scoping is the load-bearing part: `next.config.mjs` rewrites `/api/*` straight to
the API host, so a cookie on `Path=/` would ride along on every tenant request the browser
makes. It is also why the cookie carries no `__Host-` prefix, which would require `Path=/`.

> **The cookie is the credential.** There is no session to revoke and no expiry to shorten:
> stealing the cookie is stealing a token that authenticates every tenant on the deployment.
> It is a session cookie, so closing the browser ends access from that machine, and
> **rotating `PLATFORM_ADMIN_TOKEN` is what revokes a credential** — deleting one entry
> revokes one operator without disturbing the rest (TAR-166). Replacing this with a real
> platform-admin identity is the follow-up `platform-admin.guard.ts` itself flags.

Every write is attributed: the guard publishes the label of the entry that matched onto the
request scope, and it lands in `audit_logs.actor_label` and on the lifecycle trail. The
console shows it — the trail's **Actor** column is that label.

`proxy.ts` turns an operator with no cookie away from `/admin/*` before the page renders,
carrying where they were going in `?next=`. That check is presence only; the authoritative
one is the call each screen makes, which redirects back to the form if the token has stopped
being accepted.

## The screens

| Path                    | What it does                                                     | Behind it                                |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| `/admin/tenants`        | Looks a tenant up by slug                                        | nothing — it navigates                   |
| `/admin/tenants/{slug}` | Lifecycle state, the trail with `reason`, suspend and reactivate | `GET`/`POST /admin/tenants/{slug}/…`     |
| `/admin/domains`        | The custom-domain activation queue, and marking one attached     | `GET /admin/domains`, the activate pair  |
| `/admin/webhook-events` | Replays one parked inbound event                                 | `POST /admin/webhook-events/{id}/replay` |

### Tenant state is derived, not read

The admin API has **no tenant read**. Every route that reports a status is a write, so the
console takes the tenant's current state from the head of
`GET /admin/tenants/{slug}/lifecycle`, which returns newest first. Every transition writes a
row inside the transaction that makes it, so there is no state the trail does not carry.

A tenant with an **empty trail** therefore has no readable state, and the console says
"Not recorded" and offers neither operator action rather than guessing. That is not
theoretical: `lifecycle_events` was added after tenants existed.

Which actions are offered comes from `TENANT_STATUS_TRANSITIONS` in the contract — the same
object the API's state machine throws against — narrowed for reactivation to the three
states the route exists to restore from (`suspended`, `past_due`, `cancelled`). `trialing →
active` is a legal edge and is deliberately **not** offered: a button labelled "Reactivate"
on a tenant running its trial would end the trial early.

### The domain queue records; it does not attach

Attaching a hostname at the edge and issuing its certificate happens in the hosting
dashboard — TAR-416 declined to invent a contract against an API nobody here had read. The
queue's buttons write down that it has been done. See
[the custom domains runbook](../runbooks/custom-domains.md).

### Webhook replay takes an id, because there is no list

`POST /admin/webhook-events/{id}/replay` is the only route on that controller, and
deliberately so (TAR-94): the flagship parked event is a number connected _after_ its
customers messaged it, so the row names no tenant and could not be listed under one. The
field's hint carries the query that produces an id. A repeat is a `409` naming the status
the event is really in, and the console shows that sentence verbatim.

## What the console cannot do, and why

None of these is an unfinished screen. Each is a surface the API does not have.

| Missing                    | Why                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **A tenant list**          | There is no `GET /api/v1/admin/tenants`. Every tenant read on the surface names one slug in its path                     |
| **A tenant detail read**   | No `GET /api/v1/admin/tenants/{slug}` either — hence the derivation above                                                |
| **Plan, seat usage, MRR**  | Those fields are on `GET /api/v1/tenant/lifecycle`, authenticated by a _tenant session_, which an operator does not have |
| **A parked-event browser** | One route, by design — see above                                                                                         |

The only cross-tenant list anywhere on the admin surface is the domain queue, which lists
domains and names the tenant that owns each. It is therefore also the only place in the
console where a tenant can be _found_ rather than typed, and its tenant cell links through.

Closing the first three needs new API, not new UI.

## Deliberately not built

- **Impersonation.** It is in the `Reqta Admin` design reference and has no API behind it.
  It is an audit and security surface rather than a small add, and wants its own review
  before either half exists.
- **Provisioning, cancelling and scheduling a deletion.** All three exist on the admin API
  (`POST /admin/tenants`, `/{slug}/cancel`, `/{slug}/delete`). They create or destroy
  tenants and want their own confirmation design; the console says so on the tenant screen
  rather than leaving the next reader to derive it from the controller.

## Running it locally

The console talks to the real API and **cannot run against the fixture transport**. The
mock router in `lib/api/mock/handlers.ts` resolves a stubbed _tenant principal_ and checks a
tenant permission for every route, and this surface has neither — so `/admin/sign-in` refuses
up front with a sentence naming what to change, rather than letting every screen fail with a
generic message.

`.env.example` ships `NEXT_PUBLIC_USE_MOCK_API=true`, so a default local checkout has to
change it:

```bash
# In .env
NEXT_PUBLIC_USE_MOCK_API=false
API_BASE_URL=http://localhost:3001/api
PLATFORM_ADMIN_TOKEN=local-dev:local_dev_only_platform_admin_token_not_a_secret
```

Then present `local_dev_only_platform_admin_token_not_a_secret` — the secret half, without
the `local-dev:` label — at `/admin/sign-in`.
