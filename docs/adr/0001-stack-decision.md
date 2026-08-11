# ADR 0001 — Stack decision

- **Status**: Accepted
- **Date**: 2026-08-09
- **Issue**: TAR-38 (Repository scaffold + stack decision doc), under TAR-34 / TAR-18
- **Author**: Senior Software Architect
- **Supersedes**: nothing. This is the first architectural decision on the project.

## Context and problem

TAR-18 is a full-product build: a multi-tenant, white-label WhatsApp CRM and helpdesk
with a shared real-time inbox, ticketing, SLA timers, a workflow builder, an
LLM-backed chatbot, reporting, and per-seat subscription billing on Polar.sh.

`tarekmodev/whatsappcrm` was **greenfield** when this decision was taken — one commit,
containing `LICENSE` and nothing else. The `local_directory` resource on the project
holds requirements drafts only, no code. There is therefore **no existing stack to
inherit**: every choice below stands on its own merits rather than on compatibility
with prior work. That is a one-time privilege, and also a one-time risk — nothing here
gets corrected for free later.

Three properties of this product drive the choices more than anything else:

1. **Multi-tenant isolation is foundational.** Tenancy has to be in the data model and
   the execution context from the first line, not retrofitted.
2. **The inbox is real-time.** Agents must see inbound WhatsApp messages without
   refreshing, which rules out any deployment target that cannot hold long-lived
   connections.
3. **Meta's webhook will not wait.** Inbound message delivery is a third-party webhook
   that must be acknowledged fast and must never be dropped, which forces a durable
   ingest buffer and a background worker.

## Goals / Non-goals

**Goals**

- Fix the stack so TAR-39 through TAR-45 and every sibling TAR-18 story can start.
- Answer the specific questions TAR-34 asks: backend, frontend, database, real-time
  transport, background job mechanism, deployment target — plus the two additions
  accepted on TAR-34's review thread: **migration tooling**, and **whether the
  deployment target's managed database covers backup/PITR** (so TAR-43 does not
  restart that decision).
- Land a scaffold that lints, type-checks, builds and tests green, so TAR-40 has
  something real to gate.
- Provide the `tenantId` binding point TAR-41 needs for tenant-tagged logging.

**Non-goals**

- Module boundaries, DTO conventions, error taxonomy, the tenant-scoping mechanism at
  the data layer, and the webhook ingestion design. **All of that is TAR-39.** This ADR
  picks tools; TAR-39 designs the system with them.
- Any feature work. The scaffold has one endpoint (`GET /api/health`) and one page.
- Provisioning environments, secrets, logging, error tracking (TAR-41), local seed data
  (TAR-42), CI (TAR-40), or backups (TAR-43).

## Verdict on the proposed default

TAR-34 and TAR-18 both carry **NestJS + Next.js + PostgreSQL** as the assumed stack,
justified by the squad's standing expertise.

> **Confirmed, all three, unchanged.** Reasoning per decision below. The greenfield
> repository means this was re-examined rather than rubber-stamped: nothing about this
> product's shape argues against any of the three, and two of them (Nest's module/DI
> structure, Postgres's row-level security) are actively good fits for the multi-tenant
> requirement.

Nine further decisions were required that neither issue named. They are recorded here
with the same two-options-minimum discipline, because they are equally expensive to
reverse later.

## Decisions

| #   | Concern                | Choice                                 | Alternatives considered            | Rationale                                                    |
| --- | ---------------------- | -------------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| 1   | Repository shape       | Monorepo — pnpm workspaces + Turborepo | Two repos; Nx                      | One atomic commit changes an API contract and both consumers |
| 2   | Language / runtime     | TypeScript 5.9 on Node 22 LTS          | Go or Python API                   | One language across API, web and shared contracts            |
| 3   | Backend framework      | **NestJS 11**                          | Fastify + hand-rolled structure    | Opinionated module/DI structure survives a 15-story build    |
| 4   | Frontend framework     | **Next.js 16, App Router**             | Remix; Vite SPA                    | Server components, and per-tenant custom-domain routing      |
| 5   | Database               | **PostgreSQL**                         | MySQL; MongoDB                     | Row-level security is a real tenant-isolation backstop       |
| 6   | ORM + migrations       | Prisma                                 | Drizzle; TypeORM                   | Best-known Postgres ORM; explicit down-migration convention  |
| 7   | Real-time transport    | Socket.IO + Redis adapter              | Server-Sent Events; Pusher/Ably    | Rooms map onto tenants; scales on Redis we already run       |
| 8   | Background jobs        | BullMQ on Redis                        | pg-boss; managed queue             | Delayed + repeatable jobs are exactly what SLA timers need   |
| 9   | Deployment target      | Render                                 | Railway; Fly.io; AWS ECS           | Managed Postgres + Redis + persistent WebSockets, low ops    |
| 10  | Validation / contracts | Zod in `packages/contracts`            | class-validator + DTO classes      | One schema validates the API and types the frontend          |
| 11  | Testing                | Jest (API) + Vitest (web, packages)    | Vitest everywhere; Jest everywhere | Avoids decorator-metadata friction in a decorator-heavy app  |
| 12  | Lint / format          | ESLint flat config + Prettier          | Biome                              | Plugin ecosystem we actually need, including Next's          |

Versions above are as installed in this commit and verified from the lockfile.
Packages named but not yet installed (Prisma, BullMQ, Socket.IO) carry no version here
deliberately — the story that installs one pins it.

---

### 1. Monorepo — pnpm workspaces + Turborepo

**Trade-off axis: coordination cost vs. tooling complexity.**

The API and the frontend share one thing that matters enormously here: the API contract.
TAR-39's whole deliverable is a contract that backend and frontend build against in
parallel. In split repositories that contract becomes a published package with its own
version, and every contract change becomes a three-PR dance. In a monorepo it is
`packages/contracts`, and a breaking change fails the type-check of both consumers in
the same commit — which is exactly the feedback you want.

- **Rejected — two repositories.** Genuinely simpler CI. Rejected because contract drift
  between API and frontend is the single most likely source of integration bugs across
  fifteen parallel stories, and split repos make that drift invisible until runtime.
- **Rejected — Nx.** Better generators and a stronger dependency graph than Turborepo.
  Rejected as too much machinery for four packages; Turborepo is task running and
  caching and nothing else, which is all we need. Nx remains a reasonable migration if
  the workspace grows past roughly a dozen packages.

pnpm over npm workspaces for strict, non-flat `node_modules` — a package can only import
what it actually declares, which prevents the phantom-dependency class of bug where CI
passes and production cannot resolve a module.

### 2. TypeScript on Node 22 LTS

**Trade-off axis: per-service optimality vs. one language across the stack.**

Node 22 is the active LTS line and is pinned in `.nvmrc` and `engines`.

TypeScript is pinned to the **5.x** line. TypeScript 7 (the native port) is published and
resolves as `latest`, but `typescript-eslint` 8 declares a peer range of `>=4.8.4 <6.1.0`
and the toolchain warns against 7. Adopting it is a deliberate later upgrade, not
something to inherit by accident on day one.

- **Rejected — Go or Python for the API.** Either is defensible on raw throughput or
  ecosystem. Rejected because a second language costs a shared contract package, a second
  CI toolchain, and a second thing every engineer must be fluent in, for a workload that
  is overwhelmingly I/O-bound (WhatsApp API calls, database queries, LLM calls) and so
  gains little from a faster runtime.

### 3. Backend — NestJS 11 (confirms the default)

**Trade-off axis: framework structure vs. framework weight.**

- **Chosen.** Fifteen stories will be built by multiple agents in parallel over months.
  Nest's modules, DI and guard/interceptor pipeline give that work a shape it does not
  have to invent — and, specifically, they give tenant scoping obvious homes: a guard for
  authorization, a middleware for context, an interceptor for the error envelope. Nest's
  worker and WebSocket integrations are first-party, so the queue consumer and the
  realtime gateway live in the same DI container as the HTTP layer and share the tenant
  context service unchanged.
- **Rejected — Fastify with a hand-rolled structure.** Faster and far less magic. Rejected
  because "hand-rolled structure" means the conventions live in someone's head; across a
  parallel multi-agent build, an opinionated framework is a coordination mechanism, not
  overhead.

### 4. Frontend — Next.js 16 App Router (confirms the default)

**Trade-off axis: framework capability vs. a rendering model the team must learn.**

- **Chosen.** Two product requirements make Next.js more than a default. White-labelling
  requires **per-tenant custom domains** with per-tenant branding: middleware-based host
  resolution plus server components lets the correct tenant theme render on the first
  byte rather than flashing a default. And the reporting screens are read-heavy server
  data, which server components fetch without shipping a client data layer.
- **Rejected — Remix / React Router.** A cleaner data model, honestly. Rejected on
  ecosystem depth and hiring pool, and because the custom-domain and streaming stories are
  more travelled on Next.
- **Rejected — Vite SPA + a separate static host.** Simplest possible build. Rejected
  because everything above becomes client-side work, and white-label branding then flashes
  the wrong theme on every cold load.

### 5. Database — PostgreSQL (confirms the default)

**Trade-off axis: isolation guarantees and query power vs. operational simplicity.**

- **Chosen.** The deciding factor is **row-level security**. TAR-18 requires that no
  tenant reach another tenant's data "at the data layer, not just the UI". RLS makes that
  a database-enforced property rather than a promise that every future query remembers its
  `WHERE tenant_id = ?`. Given that fifteen stories' worth of queries will be written by
  multiple agents, a backstop the database enforces is worth a great deal. Postgres also
  covers the reporting workload (window functions, `JSONB` for per-tenant custom fields
  and workflow definitions, full-text search over conversation history) without a second
  datastore.
  **TAR-39 decides whether RLS is actually switched on** or whether scoping is enforced
  purely in the application layer; this decision only guarantees the option exists.
- **Rejected — MySQL.** Perfectly capable of the workload. Rejected: no row-level
  security, and weaker `JSONB` and full-text support.
- **Rejected — MongoDB.** Rejected outright. Ticketing, SLA and billing are relational,
  transactional workloads, and per-tenant isolation is far harder to enforce structurally.

### 6. ORM and migration tooling — Prisma

**Trade-off axis: developer experience vs. first-class reversible migrations.**

This decision was added to TAR-38's scope on TAR-34's review thread, because TAR-41 must
apply migrations automatically at deploy time and TAR-42 needs a runner to seed against,
and neither issue owned _choosing_ the tool.

- **Chosen.** Prisma is the best-known Postgres ORM in the Node ecosystem, generates fully
  typed clients from a single schema file, and has a migration workflow (`migrate dev` /
  `migrate deploy`) built for exactly the "applied automatically as part of deployment"
  requirement.
- **The known gap, stated plainly.** Prisma does not generate **down** migrations. TAR-34
  requires migrations be reversible. The mitigation is a convention, and it must be
  written into the contributing guide by TAR-41: _every migration directory carries a
  hand-written `down.sql` alongside Prisma's `migration.sql`, generated with
  `prisma migrate diff` and reviewed like any other code._ This is a real, recurring tax —
  it is accepted knowingly, in exchange for the DX and familiarity. **Needs verification**
  at implementation time that `prisma migrate diff` produces usable down SQL for this
  schema's shape.
- **Rejected — Drizzle.** SQL-first, lighter, and with more direct RLS ergonomics — the
  strongest challenger, and the one to revisit if the Prisma down-migration tax proves
  worse than estimated. Rejected on ecosystem maturity and on the hiring/onboarding
  argument: more engineers know Prisma.
- **Rejected — TypeORM.** The only candidate with native up/down migrations, which is
  precisely the gap above. Rejected on weaker type safety and a rockier maintenance
  history; buying reversible migrations at the cost of the ORM's day-to-day quality is the
  wrong trade for a codebase this size.

### 7. Real-time transport — Socket.IO over WebSockets, Redis adapter

**Trade-off axis: transport simplicity vs. fan-out and bidirectionality.**

- **Chosen.** The inbox needs per-tenant and per-conversation fan-out. Socket.IO's **rooms**
  are that primitive directly: join a socket to `tenant:{id}` and `conversation:{id}` and
  the isolation boundary is explicit in the transport rather than reimplemented per
  feature. Nest ships a first-party Socket.IO adapter, so gateways are ordinary Nest
  providers with the same DI and the same tenant context service. Horizontal scaling uses
  the Redis adapter — and Redis is already in the stack for the queue (decision 8), so
  this costs no new infrastructure component.
  Typing indicators, presence and read receipts are all plausible near-term inbox
  features, and all of them want a channel that goes both ways.
- **Rejected — Server-Sent Events.** Meaningfully simpler: plain HTTP, no adapter, built-in
  reconnection. Genuinely sufficient for "new message arrived", which is one-way. Rejected
  because there is no rooms primitive — the per-tenant fan-out we would have to build by
  hand is exactly the piece where a tenant-isolation bug would be most damaging — and
  because the first bidirectional feature forces a second transport alongside it.
- **Rejected — Pusher / Ably / other managed realtime.** Removes the scaling problem
  entirely. Rejected on two counts: per-message cost on a product whose whole volume is
  messages, and tenant isolation becoming a third party's channel-authorization model
  rather than ours.

> **Coupling this creates:** the API must run somewhere that supports long-lived
> connections. This eliminates pure request/response serverless platforms as an API host
> and directly constrains decision 9.

### 8. Background jobs — BullMQ on Redis

**Trade-off axis: one more infrastructure component vs. scheduling capability.**

Work that must not happen inside the request: WhatsApp webhook processing, outbound send
retries with backoff, **SLA timers**, scheduled workflow actions, LLM chatbot calls, and
per-period usage-counter rollups for billing.

- **Chosen.** SLA timers and scheduled workflow actions are _delayed jobs_, and volume
  allowance rollups are _repeatable jobs_. BullMQ has both as first-class primitives, so
  two of TAR-18's features get their scheduling engine for free rather than as a
  hand-rolled cron table. Nest integration is first-party. Redis is already required by
  decision 7, so the "extra component" objection does not apply.
- **Rejected — pg-boss.** Postgres-backed, so zero new infrastructure — the argument that
  would have won had we chosen SSE. Rejected because Redis arrives anyway with Socket.IO,
  and because putting queue churn on the same primary database that holds tenant data
  couples two very different load profiles.
- **Rejected — managed queues (SQS, Inngest, Trigger.dev).** Less to operate. Rejected on
  vendor coupling for a capability BullMQ provides locally, and because local development
  stops being self-contained.

> **Failure coupling this creates:** Redis now backs both realtime and the queue. See
> _Failure modes_ — the webhook ingestion path is deliberately designed so that Redis
> being down degrades the product rather than losing messages.

### 9. Deployment target — Render

**Trade-off axis: operational burden vs. control.**

Requirements this had to satisfy: long-lived WebSocket connections (decision 7), managed
Postgres with automated backups (TAR-43), managed Redis, three isolated environments with
separate databases and credentials (TAR-41), a secrets mechanism that is not a committed
file, and migrations applied as part of deploy.

- **Chosen.** Render covers all of it in one vendor: web services with persistent
  connections, managed Postgres, managed Key Value (Redis-compatible), private
  networking between services, per-environment variable groups for secrets, a
  `render.yaml` blueprint so environments are defined in the repository rather than
  clicked into existence, and a pre-deploy hook — which is where `prisma migrate deploy`
  will run.
- **Rejected — Railway.** Very close, arguably nicer DX. Rejected on a weaker managed
  backup/PITR story, which matters directly to TAR-43.
- **Rejected — Fly.io.** Best-in-class for long-lived connections and global placement.
  Rejected because its database story has historically pushed more operational
  responsibility onto the team, and this squad should not be operating Postgres.
- **Rejected — AWS ECS/Fargate + RDS + ElastiCache.** The most control, the best
  compliance and regional story, and the obvious destination at real scale. Rejected
  _for now_ as disproportionate: it is weeks of infrastructure work for a product with
  zero tenants, and TAR-34 needs environments this sprint.

**Frontend hosting: also Render**, as a Node web service. Vercel is the better Next.js
host in the abstract, and its domain API is attractive for programmatic per-tenant custom
domains. It was rejected for now because a second vendor buys a cross-origin cookie
problem and a split secrets story on day one. Because the frontend talks to the API over
plain HTTP, moving it to Vercel later is a contained migration — this is a reversible
decision and should be revisited when custom-domain provisioning is actually built.

#### Backup and PITR coverage — the answer TAR-43 needs

Render's managed Postgres provides **provider-managed automated backups**, with
point-in-time recovery available on paid instance types. **This must be verified against
Render's current documentation and the specific instance tier at provisioning time
(TAR-41)** — capability by tier is exactly the kind of thing that changes, and this ADR
does not invent the specifics.

The consequence for **TAR-43** is a scope change worth stating explicitly: TAR-43 is
**not** "build a backup system". It is _(a)_ confirm the provider's automated backup
schedule and retention, _(b)_ document them, and _(c)_ perform and record an actual
restore drill against a non-production target. If verification at TAR-41 finds the chosen
tier does not include automated backups, TAR-43 reverts to building a scheduled
`pg_dump`-to-object-storage job, and that finding should be raised on TAR-34 immediately
because it changes the estimate.

### 10. Validation and shared contracts — Zod

**Trade-off axis: Nest-native conventions vs. one schema shared with the frontend.**

- **Chosen.** A Zod schema in `packages/contracts` is simultaneously the API's runtime
  validation, the API's TypeScript types, the frontend's types, and the frontend's form
  validation. One definition, four uses, and a contract change breaks the build on both
  sides at once. Already demonstrated in the scaffold: `HealthResponseSchema` types the
  Nest controller's return value and is asserted against the live response in the API's
  test.
- **Rejected — class-validator + class-transformer.** The Nest default, with mature
  Swagger integration. Rejected because decorator-annotated DTO classes cannot be shared
  with the frontend without dragging `reflect-metadata` and the decorator runtime into the
  browser bundle, which forfeits the entire benefit of the monorepo's contracts package.

TAR-39 owns the conventions built on this: endpoint shape, DTO naming, error-code
taxonomy, and OpenAPI generation.

### 11. Testing — Jest for the API, Vitest for web and packages

**Trade-off axis: one uniform runner vs. avoiding a known configuration hazard.**

- **Chosen.** NestJS is decorator-heavy and depends on `emitDecoratorMetadata` for DI.
  Jest with `ts-jest` compiles through the TypeScript compiler, so that metadata simply
  works — it is Nest's default for a reason. Vitest on a Nest codebase needs an SWC
  transform plugin to emit decorator metadata; it is documented and widely used, but it is
  a persistent configuration seam in the one part of the stack where a subtle failure
  looks like a mysterious DI error. Vitest is the natural runner for the React app and for
  the plain-TypeScript packages. Turborepo hides the split behind a single root
  `pnpm test`, so CI (TAR-40) sees one command.
- **Rejected — Vitest everywhere.** One runner, one config idiom, faster. Rejected on the
  decorator-metadata seam above; the uniformity is not worth a foundation-level flake.
- **Rejected — Jest everywhere.** Also uniform. Rejected because Jest's ESM story is the
  worse end of the same trade, and React testing has moved to Vitest.

### 12. Lint and format — ESLint flat config + Prettier

**Trade-off axis: speed and simplicity vs. rule coverage.**

- **Chosen.** ESLint's flat config at the repository root covers all workspaces in one
  run, with `@next/eslint-plugin-next` scoped to `apps/web`. Prettier owns formatting;
  `eslint-config-prettier` is applied last so the two never fight.
- **Rejected — Biome.** Dramatically faster and one tool instead of two. Rejected because
  the rules we specifically want — Next's own plugin, and type-aware `typescript-eslint`
  rules such as `no-floating-promises` — are not equivalently covered.
- **Follow-up for TAR-40 — done.** The scaffold shipped with `typescript-eslint`'s
  **non-type-checked** recommended set. TAR-40 moved it to `recommendedTypeChecked`
  with `parserOptions.projectService`, so `no-floating-promises` and the `no-unsafe-*`
  family are live before the codebase fills up with queue producers. Plain JavaScript
  sits outside every `tsconfig` and is excluded from the type-aware rules.

---

## What the scaffold actually contains

```
whatsappcrm/
├── apps/
│   ├── api/                       NestJS 11
│   │   └── src/
│   │       ├── common/tenant-context/   AsyncLocalStorage tenant scope  ← TAR-39/41 binding point
│   │       ├── config/                  Zod-validated environment, fails fast at boot
│   │       ├── health/                  GET /api/health                 ← TAR-41 adds real probes
│   │       ├── bootstrap.ts             shared by main.ts and the e2e tests
│   │       └── main.ts
│   └── web/                       Next.js 16, App Router
│       ├── app/                         layout + placeholder page
│       ├── components/                  StatusBadge, typed by the contracts package
│       └── lib/api.ts                   the single API client; one error type
├── packages/
│   ├── contracts/                 Zod schemas shared by both apps       ← TAR-39 fills this out
│   └── tsconfig/                  shared TypeScript bases
├── docs/adr/0001-stack-decision.md
├── .env.example                   every key, no values
├── eslint.config.mjs · .prettierrc.json · turbo.json · pnpm-workspace.yaml
```

Verified green in this commit, on Node 22 / pnpm 9.15:

| Command                                 | Result                                                           |
| --------------------------------------- | ---------------------------------------------------------------- |
| `pnpm build`                            | 3 packages built                                                 |
| `pnpm typecheck`                        | clean from a cold clone (no prior build)                         |
| `pnpm test`                             | 20 tests passing across 5 files                                  |
| `pnpm lint`                             | clean                                                            |
| `pnpm format:check`                     | clean                                                            |
| `node dist/main.js` → `GET /api/health` | `200`, contract-valid body, `x-request-id` set, no boot warnings |

**Deliberately absent.** Prisma, Socket.IO and BullMQ are decided here but **not
installed**. Installing dependencies with no code behind them produces dead weight and
unused-import lint noise, and each belongs to the story that first needs it — Prisma with
the data model (TAR-39/TAR-42), BullMQ and Socket.IO with the webhook and inbox stories.
This ADR is what stops those stories re-litigating the choice.

### The tenant context binding point

`TenantContextService` (`apps/api/src/common/tenant-context/`) is the piece the review
thread on TAR-34 asked for, and the one part of the scaffold that is a design decision
rather than boilerplate.

It uses `AsyncLocalStorage` rather than a Nest `REQUEST`-scoped provider. Request scoping
forces Nest to re-instantiate the entire dependent provider subtree per request, and —
decisively — it does not exist at all in the two other places tenant scoping is needed:
**queue workers** and **WebSocket handlers**. `AsyncLocalStorage` covers all three
execution contexts with one API.

Ownership, so nobody builds a second one:

| Story         | Uses it for                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------- |
| TAR-35 (auth) | calls `setTenant()` once the session is verified                                             |
| TAR-39        | decides how `tenantId` reaches the data layer (RLS session variable, or a query-level guard) |
| TAR-41        | reads `requestId` and `tenantId` for tenant-tagged structured logging and error tracking     |

`requireTenantId()` throws rather than returning null, so an un-scoped execution path
fails loudly instead of quietly querying across tenants.

## Failure modes

| Component          | Down                                                                                                                                                          | Slow                                                                                                  | Bad data                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| PostgreSQL         | Total outage. Health endpoint reports `down`; no meaningful degraded mode                                                                                     | Every request slows; queue workers back up. Needs connection-pool and slow-query alerting from TAR-41 | Tenant isolation regression is the severe case — RLS is the structural backstop (TAR-39)         |
| Redis              | **Realtime and queue both stop.** Inbox stops updating live; jobs stop draining. Mitigated by the ingest pattern below — messages are not lost, they are late | Perceptible inbox lag; SLA timers fire late, which has contractual meaning                            | Adapter or queue corruption drops events; jobs must be idempotent and replayable                 |
| WhatsApp Cloud API | No send, no receive. Outbound queues with backoff; inbound is Meta's retry to handle                                                                          | Sends queue up; the 24-hour session window may expire mid-retry and force a template                  | Malformed or duplicated webhooks — signature verification and idempotency keys required (TAR-39) |
| Render platform    | Full outage; single-vendor risk, accepted at this scale                                                                                                       | —                                                                                                     | —                                                                                                |

**Webhook ingestion — the durability rule.** Meta expects a fast `200` and retries with
backoff before eventually giving up. If the API enqueues straight to Redis, a Redis
outage becomes silent message loss.

> The ingestion path must **persist the raw webhook payload to Postgres first, respond
> `200`, and only then enqueue**, with a sweeper that re-enqueues unprocessed rows.

Redis then becomes a _latency_ dependency rather than a _durability_ dependency — the
single most valuable property in the whole design, given decisions 7 and 8 both lean on
it. **TAR-39 owns the detailed design; this ADR states it as a constraint on that design**
so it is not discovered late.

## Security and access

- **Repository access verified**, not re-linked: `tarekmodev/whatsappcrm` is already the
  project's `github_repo` resource. Read confirmed via `git ls-remote`; **write confirmed
  via `git push --dry-run`**.
- No credentials anywhere in the repository. `.env.example` documents every key with no
  values, and `.gitignore` excludes `.env*` except the example.
- Environment validation is fail-fast: `apps/api/src/config/env.schema.ts` rejects an
  invalid environment at boot rather than surfacing `undefined` at the first request that
  needs the key. `DATABASE_URL` and `REDIS_URL` are optional _only_ so the scaffold boots
  with no infrastructure; **TAR-41 promotes them to required.**
- `NEXT_PUBLIC_*` values are inlined into the browser bundle. `.env.example` says so
  explicitly, next to the one variable that uses the prefix.
- CORS is an explicit allow-list of `WEB_ORIGIN`, with credentials enabled — not `*`.
- Every response carries `x-request-id`, echoing the caller's if present. That id appears
  in the error envelope, so a user-reported error maps to a log line and an error-tracker
  event. An inbound value is repeated only if it is at most 128 unreserved URL characters;
  anything else is replaced with a fresh UUID, because the API does not trust the proxy in
  front of it and an unbounded id would be a caller choosing the platform's log bill.

## Open questions and risks

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                      | Severity                                                                      | Proposed resolution                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | **Data residency.** The client is Saudi-based. No compliance requirement was stated, and this ADR does not assume one — but Render's regions do not include the Middle East, and WhatsApp conversation content is personal data. If residency is required, decision 9 changes to AWS `me-central-1` and the infra estimate grows substantially                                                            | **High** — cheap to answer now, expensive to discover after TAR-41 provisions | Direct question to Tarek, **before TAR-41 provisions anything**                                         |
| 2   | **Branch protection ownership.** Raised on TAR-34 and still unanswered: does the squad get repo admin, or does Tarek apply protection once TAR-40 lands the workflow? Without an answer TAR-40's "CI gates the merge" has no owner and TAR-45 will find an ungated repo                                                                                                                                   | Medium                                                                        | Already escalated on TAR-34; default is that the squad requests admin                                   |
| 3   | **Prisma down-migration tax.** Needs verification that `prisma migrate diff` yields usable down SQL for this schema's shape                                                                                                                                                                                                                                                                               | Medium                                                                        | Verify in TAR-42; if it is worse than estimated, Drizzle is the recorded fallback                       |
| 4   | **Render backup/PITR by tier.** Stated above as needing verification                                                                                                                                                                                                                                                                                                                                      | Medium                                                                        | TAR-41 verifies at provisioning and reports on TAR-43                                                   |
| 5   | **Redis as a shared dependency** of realtime and queue                                                                                                                                                                                                                                                                                                                                                    | Medium                                                                        | Separate logical databases or instances (TAR-41); the durable-ingest rule above bounds the blast radius |
| 6   | **Scale ceiling.** This design is sized for the low hundreds of concurrent agent connections and a single Postgres primary — correct for a product with zero tenants. The breaking point is single-primary write throughput and Socket.IO connection count per instance. Next steps in order: read replicas for reporting, then partitioning `messages` by tenant or time, then a dedicated realtime tier | Low now                                                                       | Revisit when a real tenant load exists; do not pre-build                                                |
| 7   | **TypeScript 7** is available and deliberately not adopted                                                                                                                                                                                                                                                                                                                                                | Low                                                                           | Revisit once `typescript-eslint` supports it                                                            |

### Questions 1 and 2 — one answered, one assumed

- **Question 2 — branch protection: ANSWERED.** Tarek, on TAR-34: _"yes do all by
  yourself the token has all permissions."_ The squad has repository admin, so **TAR-40
  applies required checks itself** and the "documented as a step for Tarek" escape hatch
  in its acceptance criteria no longer applies. Note the sequencing: a required status
  check cannot be configured before the workflow that produces it exists, so TAR-40
  lands the CI workflow first and applies protection second, in that order.
  **Resolved, via a second decision this ADR now has to record.** TAR-40 landed the
  workflow and then found that GitHub gates branch protection _and_ repository rulesets
  on a private repository behind a paid plan; `tarekmodev` is on Free, and both APIs
  answered `403 Upgrade to GitHub Pro or make this repository public`. Repository admin
  was never the obstacle — the feature is simply not sold on that plan. Offered the
  choice between GitHub Pro and publishing the repository, **Tarek made
  `tarekmodev/whatsappcrm` public**, and protection was applied and verified: a direct
  push to `main` is rejected with `GH006`, and a pull request with a failing check cannot
  be merged.

  The consequence belongs here rather than only in a comment thread: **this repository is
  now world-readable, permanently.** Forks, clones and search-engine caches survive a
  later flip back to private, so every future story has to treat the source as public.
  Nothing secret may enter the repository or its history — no credentials, no customer
  data, no tenant identifiers, no internal hostnames — and `.env.example` stays a list of
  key names with no values, as decision 10's configuration rule already requires.
  TAR-41's provisioning work should assume any operator making a mistake here is
  disclosing to the internet, not to a private team.

- **Question 1 — data residency: NOT answered; assumed not required.** Raised twice and
  not addressed, against two explicit instructions to continue. Proceeding on the
  assumption that no residency requirement exists — no compliance constraint has been
  stated for this product at any point — so decision 9 stands and **TAR-41 provisions on
  Render as specified.** _Trigger to revisit:_ any statement that WhatsApp conversation
  content must remain in-region, or a client contract clause to that effect. A late
  reversal costs a full environment migration to AWS `me-central-1`, so TAR-41 should
  provision development and staging first and get explicit confirmation before
  production holds real tenant data. This assumption is recorded here so it is visible
  rather than silently inherited.

## Consequences for downstream issues

- **TAR-39** — build within `apps/api/src`; fill `packages/contracts`; decide RLS vs.
  application-level scoping; design webhook ingestion **honouring the durability rule
  above**; consume `TenantContextService` rather than inventing a second mechanism.
- **TAR-40** — gate on `pnpm lint`, `pnpm typecheck`, `pnpm test` (all green today); use
  Turborepo caching; enable `recommendedTypeChecked`; resolve open question 2.
- **TAR-41** — Render environments via `render.yaml`; promote `DATABASE_URL` and
  `REDIS_URL` to required; wire logging to `TenantContextService`; `prisma migrate deploy`
  in the pre-deploy hook; add real DB/queue probes to the health endpoint; **verify open
  questions 1 and 4 before provisioning**.
- **TAR-42** — `docker-compose` for Postgres and Redis; Prisma schema and migrations;
  README run steps. Per the accepted TAR-34 correction, **seed data waits for TAR-39's
  entities**.
- **TAR-43** — verify and document the provider's backup schedule, then perform and record
  a restore drill. Not a build-it-yourself task unless open question 4 says otherwise.
