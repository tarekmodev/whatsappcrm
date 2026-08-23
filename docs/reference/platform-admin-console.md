# Platform admin console

`apps/admin`: what the operator console does, what it cannot do, and why the second list is
longer than anyone reading the design reference expects.

Written for engineers, and for the platform operator who has to work out whether a question
they have can be answered from a browser or needs psql. It is the console half of
[the platform admin API reference](admin-api.md), which documents the endpoints behind it,
and it implements Part 2 of
[the Reqta alignment spec](../design/0002-reqta-alignment-spec.md).

Everything here is operated by us, never by a customer. Nothing on this surface is reachable
by a tenant's own users under any role, and none of it goes through the session and RBAC
model that TAR-35 and TAR-22 build for tenant-facing routes.

## Why it is its own app

`apps/admin` is a separate Next app with its own bundle and its own deployment, and the
reason is **its own origin**.

Every write on this surface is cross-tenant. Had the console shipped as `/admin` inside
`apps/web`, it would have been same-origin with every tenant page on every white-label host —
so a stored XSS anywhere in the tenant console (an agent's display name, a template body, a
knowledge document) could, while an operator was signed in on that host, call the operator's
own server actions with the browser attaching the credential itself. `httpOnly` does not help
against that, `SameSite=Strict` does not help, and a path-scoped cookie does not help. A
different origin does.

### How it shares the design system without forking it

It **consumes `apps/web`'s token layer and `components/ui` wholesale** rather than copying
them. `tsconfig.json` maps `@/*` at `apps/web` and `~/*` at this app's own code, and
`transpilePackages` compiles what it finds there. A second copy of the palette is a second
design system that drifts one commit later.

That mapping is a stepping stone, not the destination. When TAR-801's shared layer lands as a
package, `@/*` becomes a dependency on it and this app's imports change in one place. What
does **not** happen either way is `apps/admin` reaching into `apps/web`'s `features/` — those
are a different product's screens, and the spec rules them out.

The console has one theme and no theme toggle: there is no account to hang preferences off,
and 0001's rule is that the shell carries nothing for a feature the app does not have.

## Getting in

There is no operator account. `PlatformAdminGuard` authenticates a **shared bearer token**
from `PLATFORM_ADMIN_TOKEN`, whose entries are `label:secret` pairs — the operator is not a
user inside any tenant, so there is nothing for a session lookup or a per-tenant role to
resolve them against, and provisioning has to work before the first tenant exists.

So "signing in" is presenting a credential, and the screen says so rather than drawing an
email-and-password form for something that is neither:

1. `/credential` takes the secret half of one entry — the part after the `label:`. The path
   says what the screen is: there is no account, no password and no session, so `/sign-in`
   would be the first thing on it that was untrue.
2. The console verifies it against `GET /api/v1/admin/domains`, the only read on the whole
   admin surface that names no tenant, and stores it on success.
3. It is kept in an `httpOnly`, `SameSite=Strict`, `__Host-`-prefixed cookie and read back
   **on the server** for every call. No component receives it and no client bundle contains
   it — and `next.config.mjs` ships no `/api` rewrite, so there is no browser path to the API
   from this origin at all.

The `__Host-` prefix is affordable here precisely because this is its own app: the prefix
requires `Path=/`, and here `/` _is_ the whole console. The browser then enforces the rest —
set over HTTPS, by this exact host, with no `Domain` — which is what stops a sibling
subdomain writing a credential into it. The name drops the prefix on plain HTTP, because a
`__Host-` cookie without `Secure` is one the browser refuses outright, and local development
is HTTP.

> **The cookie is the credential.** There is no session to revoke and no expiry to shorten:
> stealing the cookie is stealing a token that authenticates every tenant on the deployment.
> It is a session cookie, so closing the browser ends access from that machine, and
> **rotating `PLATFORM_ADMIN_TOKEN` is what revokes a credential** — deleting one entry
> revokes one operator without disturbing the rest (TAR-166). Replacing this with a real
> platform-admin identity is the follow-up `platform-admin.guard.ts` itself flags.

Every write is attributed: the guard publishes the label of the entry that matched onto the
request scope, and it lands in `audit_logs.actor_label` and on the lifecycle trail. The
console shows it — the trail's **Actor** column is that label — and the credential screen says
so, because that sentence is the only place an operator learns the trail names a credential
rather than them.

**A credential refused mid-session is never a silent redirect.** The ordinary cause is the
token being rotated under an operator mid-incident, and bouncing them to the front door leaves
them wondering what they did. Every screen renders the same interrupting state with one action
back to `/credential`. Absence of a cookie _is_ an ordinary redirect — `proxy.ts` does it before
the page renders, carrying `?next=`.

## The screens

| Path              | What it does                                                             | Behind it                                   |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| `/credential`     | Takes the operator token                                                 | `GET /admin/domains` as the probe           |
| `/tenants`        | Opens a tenant by slug, provisions one, and lists the domain queue       | `GET /admin/domains`, `POST /admin/tenants` |
| `/tenants/{slug}` | Lifecycle state, the trail with `reason`, and the four per-tenant writes | `GET`/`POST /admin/tenants/{slug}/…`        |
| `/domains`        | The same domain queue on a route of its own                              | `GET /admin/domains`, the attach pair       |
| `/webhooks`       | Replays one parked inbound event, with a session log                     | `POST /admin/webhook-events/{id}/replay`    |

### Tenant state is derived, not read

The admin API has **no tenant read**. Every route that reports a status is a write, so the
console takes the tenant's current state from the head of
`GET /admin/tenants/{slug}/lifecycle`, which returns newest first
(`occurredAt desc, id desc`). Every transition writes its row inside the transaction that
makes it, so there is no state the trail does not carry. **That derivation is the seam that
changes when a detail read lands.**

A tenant with an **empty trail** therefore has no readable state, and the console says
"Not recorded" and offers no writes at all rather than guessing. That is not theoretical:
`lifecycle_events` was added after tenants existed.

Which writes are offered comes from `TENANT_STATUS_TRANSITIONS` in the contract — the same
object the API's state machine throws against — narrowed for reactivation to the three states
the route exists to restore from (`suspended`, `past_due`, `cancelled`). `trialing → active`
is a legal edge and is deliberately **not** offered: a control labelled "Reactivate" on a
tenant running its trial would end the trial early. A tenant in `deleted` has no edge out, so
the whole menu is omitted rather than disabled.

### The five writes

Provision, suspend, reactivate, cancel and delete, all through `FormDialog`, all naming their
subject. Two are worth calling out:

- **Provisioning distinguishes `201` from `200`.** `200` means a tenant already existed at
  that slug and _nothing changed_; the dialog stays open and says so with a link to it.
  Treating the idempotent replay as a success is how an operator concludes they created
  something they did not.
- **Deleting immediately requires typing the slug.** It is the only type-to-confirm in the
  product, and it is the one action that destroys customer data on a clock the operator just
  shortened. Scheduled is the default mode, and the submit's verb changes with the mode so it
  never reads milder than what pressing it does.

### The domain queue records; it does not attach

Attaching a hostname at the edge and issuing its certificate happens in the hosting
dashboard — TAR-416 declined to invent a contract against an API nobody here had read. The
queue's buttons write down that it has been done. See
[the custom domains runbook](../runbooks/custom-domains.md). They are not confirmed: each is
reversible by the control in the other half of the queue.

### Webhook replay takes an id, because there is no list

`POST /admin/webhook-events/{id}/replay` is the only route on that controller, and
deliberately so (TAR-94): the flagship parked event is a number connected _after_ its
customers messaged it, so the row names no tenant and could not be listed under one. The card
names the runbook query that produces an id, and a **session log** below the form keeps every
replay made in that tab — an operator working a batch needs to see what they have already
done, and the card says the list is not saved.

A repeat is a `409` naming the status the event is really in, and the console shows that
sentence verbatim.

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

Closing the first three needs new API, not new UI. **When `GET /admin/tenants` lands it
replaces the lookup card and nothing else** — the domain queue stays where it is, and the
lookup's field becomes the new table's search box.

Three smaller consequences of the same gap, all visible on `/tenants/{slug}`:

- the `<h1>` is the **slug**, not the tenant's name, because no read returns a name;
- the Lifecycle card carries only what the trail knows. The dates the spec lists
  (`trialEndsAt`, `purgeAt`, …) live on `AdminTenantLifecycleResponse`, which is a _write_
  response, so a console that has not made one this session genuinely does not have them. The
  card says that rather than rendering six empty rows;
- the status band carries **one** chip. §2.4 allows a second, time-bounded one — `Trial
ends`, `Grace period ends`, `Purges` — and every date it could name is on that same write
  response. The banner on a purged tenant drops its date for the same reason and still says
  the sentence.

## Deliberately not built

- **Impersonation.** It is in the `Reqta Admin` design reference and has no API behind it.
  Nothing renders an impersonate control, disabled or otherwise — a disabled control is still
  a promise, and this one is a promise about crossing a tenant boundary. It wants its own
  audit and security review before either half exists.

## Running it locally

The console talks to the real API and **cannot run against the fixture transport**. The mock
router in `apps/web/lib/api/mock/handlers.ts` resolves a stubbed _tenant principal_ and checks
a tenant permission for every route, and this surface has neither — so `/credential` refuses up
front with a sentence naming what to change, rather than letting every screen fail with a
generic message.

`.env.example` ships `NEXT_PUBLIC_USE_MOCK_API=true`, so a default local checkout has to
change it:

```bash
# In .env, at the repository root — both apps read it
NEXT_PUBLIC_USE_MOCK_API=false
API_BASE_URL=http://localhost:3001/api
PLATFORM_ADMIN_TOKEN=local-dev:local_dev_only_platform_admin_token_not_a_secret
NEXT_PUBLIC_ADMIN_DEPLOYMENT=development
```

```bash
pnpm --filter @whatsappcrm/admin run dev   # http://localhost:3002
```

Then present `local_dev_only_platform_admin_token_not_a_secret` — the secret half, without
the `local-dev:` label — at `/credential`.
