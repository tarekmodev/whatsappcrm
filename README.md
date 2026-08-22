# WhatsApp CRM

Multi-tenant, white-label WhatsApp CRM and helpdesk platform, built on the official
WhatsApp Business Cloud API.

> **Status: early.** This repository contains the project skeleton, the stack decision, the
> local development harness, the database schema, its tenant isolation, the two Prisma
> clients that enforce it, the platform admin surface that provisions and deactivates
> tenants, the first product path end to end — inbound WhatsApp webhooks — and the media
> pipeline that re-hosts what those webhooks carry. On the frontend it contains the
> design-token and component foundation plus the agent/team/role management console
> (TAR-82), which currently reads fixtures rather than the API — see
> [Interim state](#interim-state-mock-api-and-stubbed-role). Feature work is tracked as the
> TAR-18 epic. The data model landed with TAR-47, row-level security with TAR-48, the
> client split with TAR-49, provisioning and deactivation with TAR-50 and TAR-51, the
> WhatsApp Business Account entity with TAR-52, webhook ingestion with TAR-20, and a
> two-tenant demo dataset with TAR-46 — so a clean clone now reaches a **populated**
> database in one command. The CRM core landed with TAR-33: a contact directory searchable by
> name, phone or email and filterable by tag, tenant-defined **custom fields** an admin
> creates under Settings and every agent fills in on a contact profile, and the eleven routes
> behind all three — see
> [the contacts, tags and custom fields API reference](docs/reference/contacts-api.md).
> Everything below works today.

## Stack

TypeScript on Node 22 · NestJS 11 API · Next.js 16 frontend · PostgreSQL · Prisma ·
Socket.IO · BullMQ on Redis · deployed to Render.

Every one of those choices, the alternatives weighed against it, and the failure modes
they imply are recorded in **[`docs/adr/0001-stack-decision.md`](docs/adr/0001-stack-decision.md)**.
Read that before proposing a change to any of them.

Prisma runs on the **`pg` driver adapter** (`@prisma/adapter-pg`), which Prisma 7 requires.
The generated client is **not committed**: `prisma generate` writes it to
`apps/api/src/generated/prisma`, and `pnpm build`, `pnpm typecheck` and `pnpm test` all
depend on a `generate` task so it cannot go stale. Run `pnpm db:generate` by hand after
changing `schema.prisma` if you want it immediately. BullMQ arrived with the webhook
ingestion pipeline, which is the first thing that needed a queue; Socket.IO arrived with
the realtime gateway (TAR-69) and runs inside the API process, on `/realtime`, alongside
`@socket.io/redis-adapter` so a room emit reaches every replica's sockets rather than only
the one that produced it.

## Layout

| Path                       | What it is                                                    |
| -------------------------- | ------------------------------------------------------------- |
| `apps/api`                 | NestJS HTTP API                                               |
| `apps/api/src/prisma`      | The `TenantPrisma` / `SystemPrisma` clients and RLS wiring    |
| `apps/api/src/queue`       | BullMQ registration and tenant context propagation into jobs  |
| `apps/api/src/webhooks`    | WhatsApp webhook ingest, its worker and the stuck-event sweep |
| `apps/api/src/media`       | Media upload, inbound download and the storage port           |
| `apps/api/src/realtime`    | Socket.IO gateway, room authorisation and the event relay     |
| `apps/api/prisma`          | Database schema and migrations                                |
| `apps/api/prisma/sql`      | Operational SQL that is not a migration — roles, RLS check    |
| `apps/api/src/seed`        | The demo dataset and the script that writes it                |
| `apps/web`                 | Next.js agent console — see [Frontend](#frontend)             |
| `apps/web/styles/tokens`   | The design token layers. A theme swap starts and ends here    |
| `apps/web/components/ui`   | Domain-free UI primitives (Button, Modal, DataTable, …)       |
| `apps/web/features`        | Domain-aware feature slices (`people`, `inbox`, `assignment`) |
| `packages/contracts`       | Zod schemas and types shared by both apps — the API contract  |
| `packages/tsconfig`        | Shared TypeScript configuration                               |
| `docker-compose.yml`       | Local PostgreSQL and Redis                                    |
| `docker/postgres/initdb.d` | First-boot SQL for the local Postgres container               |
| `docs/adr`                 | Architecture decision records                                 |
| `docs/architecture`        | Cross-cutting design documents                                |
| `docs/design`              | The visual design language every screen is built against      |
| `docs/reference`           | Data model, admin API and tenant isolation reference          |
| `docs/guides`              | Task-oriented how-tos, one goal per file                      |

## Documentation

| Document                                                                                     | What it answers                                                                    |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [ADR 0001 — stack decision](docs/adr/0001-stack-decision.md)                                 | Why each piece of the stack, and what it costs                                     |
| [Architecture and API contract](docs/architecture/0002-architecture-and-api-contract.md)     | Module boundaries, tenant resolution, the endpoint surface, webhooks               |
| [Visual design language](docs/design/0001-visual-design-language.md)                         | What the design tokens equal, the console frame, and the list/detail patterns      |
| [Data model reference](docs/reference/data-model.md)                                         | Every entity, which are tenant-scoped, which constraints and indexes matter        |
| [Tenant isolation contract](docs/reference/tenancy.md)                                       | Which Prisma client to inject, and what the database refuses                       |
| [Platform admin API](docs/reference/admin-api.md)                                            | Provisioning and deactivation: request, response, errors, retention                |
| [Tenant lifecycle state machine](docs/architecture/0012-tenant-lifecycle-state-machine.md)   | The seven states, every edge and its trigger, and which of them is built           |
| [Tenant lifecycle reference](docs/reference/tenant-lifecycle.md)                             | Starting states, plan entitlements and where they are enforced, the trail          |
| [Public signup API](docs/reference/signup-api.md)                                            | The four unauthenticated routes: verification, slug reservation, rate limits       |
| [People and teams API](docs/reference/people-api.md)                                         | Managing agents, teams and roles: permissions, invariants, isolation               |
| [Tickets API](docs/reference/tickets-api.md)                                                 | The queue, the status/priority write, handoff and escalation, the event log        |
| [Contacts, tags and custom fields API](docs/reference/contacts-api.md)                       | The CRM core: the directory, the tag taxonomy, and admin CRUD on definitions       |
| [Assignment rules API](docs/reference/assignment-rules-api.md)                               | Routing-rule CRUD, the condition grammar, and how a new ticket is routed           |
| [Auto-assignment](docs/reference/auto-assignment.md)                                         | Rotation, eligibility, workload caps, and the flagged-ticket fallback              |
| [SLA timers and supervisor alerts](docs/reference/sla-timers.md)                             | Response windows, breach detection, who is alerted, and the two endpoints          |
| [Workflow automation API](docs/reference/workflows-api.md)                                   | Workflow CRUD, the trigger/condition/action grammar, and how a run is claimed      |
| [Reporting dashboard and export](docs/reference/reporting-api.md)                            | The four metrics, the date range, scope and attribution, and export parity         |
| [Branding and custom domains API](docs/reference/branding-domains-api.md)                    | The white-label surface: branding, hostnames, DNS verification, the operator queue |
| [Canned responses API](docs/reference/canned-responses-api.md)                               | The quick-reply library: CRUD, the shortcut grammar, the picker, the relay         |
| [AI chatbot and knowledge base API](docs/reference/chatbot-api.md)                           | Knowledge-base CRUD, chatbot config, confidence gating, the two handoff routes     |
| [Changing a ticket's status and priority](docs/guides/manage-ticket-status-and-priority.md)  | For agents working in the console, not for API consumers                           |
| [Route new tickets to the right team](docs/guides/route-new-tickets-with-rules.md)           | For supervisors writing routing rules in the console                               |
| [Clear tickets nobody could take](docs/guides/clear-flagged-tickets.md)                      | For supervisors emptying the flagged queue in the console                          |
| [Watch tickets that miss their deadline](docs/guides/track-overdue-tickets.md)               | For supervisors reading the overdue badge and clearing SLA alerts                  |
| [Define the fields your contacts carry](docs/guides/define-custom-contact-fields.md)         | For admins defining custom contact fields in the console                           |
| [Find a contact and keep their record up to date](docs/guides/find-and-update-contacts.md)   | For agents searching the directory, filtering by tag and filling in fields         |
| [Read the performance dashboard](docs/guides/read-the-performance-dashboard.md)              | For supervisors reading the metrics and exporting them as a spreadsheet            |
| [Put your own brand on the workspace](docs/guides/brand-your-workspace.md)                   | For admins setting the product name, colours, logo and favicon in the console      |
| [Serve the workspace from your own web address](docs/guides/set-up-a-custom-domain.md)       | For admins adding a custom domain, with the exact DNS records to publish           |
| [Hand a ticket on, or ask a supervisor](docs/guides/hand-over-or-escalate-a-ticket.md)       | For agents reassigning a ticket or escalating one, and reading the history         |
| [Answer common questions with saved replies](docs/guides/use-saved-replies.md)               | For agents inserting a saved reply in the composer by typing a shortcut            |
| [Keep the workspace's saved replies up to date](docs/guides/manage-saved-replies.md)         | For supervisors and admins adding, editing and deleting saved replies              |
| [Set up your workspace](docs/guides/set-up-your-workspace.md)                                | For a new admin: the setup checklist, seats, and what suspension means             |
| [Automate what happens to a ticket](docs/guides/automate-tickets-with-workflows.md)          | For supervisors building trigger → condition → action workflows in the console     |
| [Set up the chatbot and its knowledge base](docs/guides/set-up-the-chatbot.md)               | For admins writing the knowledge base and deciding when the chatbot answers        |
| [Work with the chatbot in the inbox](docs/guides/work-with-the-chatbot-in-the-inbox.md)      | For agents reading a handover summary and taking a thread from the chatbot         |
| [Documentation style guide](docs/STYLE.md)                                                   | How to write the above                                                             |
| [Changelog](CHANGELOG.md)                                                                    | What has landed so far                                                             |
| [ADR 0002 — observability and environments](docs/adr/0002-observability-and-environments.md) | Logging, error tracking, the three environments, backups                           |
| [Environments runbook](docs/runbooks/environments.md)                                        | Provisioning, secrets, health, alerting, rollback                                  |
| [Migrations runbook](docs/runbooks/migrations.md)                                            | How a migration reaches an environment, and how to undo one                        |
| [Backups runbook](docs/runbooks/backups.md)                                                  | Backup coverage, restoring on Render, and the restore drill                        |

## Getting started

Requires **Node 22** (`.nvmrc`), **pnpm 9**, and **Docker** with Compose v2
(Docker Desktop covers both).

```bash
pnpm install                 # 1. dependencies
cp .env.example .env         # 2. config — the defaults match the Docker stack, no edits needed
pnpm db:up                   # 3. start PostgreSQL and Redis, wait until both are healthy
pnpm db:migrate:deploy       # 4. apply migrations to the empty database
pnpm db:roles                # 5. create the application database roles
pnpm db:roles:login          # 6. give them the throwaway local password
pnpm db:seed                 # 7. load the demo tenants, agents and conversations
pnpm dev                     # 8. run the API and the frontend
```

That is the whole setup. Step 3 blocks until both containers report healthy, so step 4
never races the database. Step 5 has to come after step 4 — it grants privileges on the
tables step 4 creates — and is idempotent, so re-running it is always safe.

Step 6 exists because `db:roles` deliberately creates both roles `NOLOGIN` and without a
password: a password belongs in an environment's secret store, not in a file in this
repository, and the same file runs in staging. `db:roles:login` is that operator step,
scripted, with the throwaway value `.env.example` already uses. Skip it and the API boots
but every query fails to authenticate.

Step 7 needs steps 5 and 6 for the same reason the API does — it connects as
`whatsappcrm_app`, not as the migration owner. See
[Seed data](#seed-data) for what it writes and why it is written that way. Skip it and
everything still runs, against an empty database.

`pnpm dev` runs both apps: the API on <http://localhost:3001/api> and the frontend on
<http://localhost:3000>.

### Check it worked

```bash
curl http://localhost:3001/api/health
# {"status":"ok","version":"0.0.0","uptimeSeconds":3,"checks":{}}

pnpm db:migrate:status
# Database schema is up to date!

pnpm db:verify:rls
# PASS — tenant isolation is enforced at the data layer

pnpm test:db
# Tests: 157 passed — the same guarantee through TenantPrisma, plus provisioning,
#                     the WhatsApp webhook ingestion pipeline, the ticket
#                     uniqueness constraint, ticket linking and media isolation
```

Step 7 prints what it wrote and where to reach it:

```text
  northwind  http://northwind.app.localhost  5 users, 5 conversations, 13 messages, 2 tickets
  southwind  http://southwind.app.localhost  2 users, 1 conversation, 2 messages, 0 tickets
```

Once the database and Redis are up, readiness reports them:

```bash
curl http://localhost:3001/api/health/ready
# {"status":"ok",...,"checks":{"database":{"status":"ok"},"queue":{"status":"ok"}}}
```

`/api/health` stays a liveness probe and deliberately measures nothing — a liveness check
that fails when the database blinks restarts a healthy process.

Skipping step 7 leaves a database with tables and no rows, which still runs. To see what
step 4 built:

```bash
docker compose exec postgres psql -U whatsappcrm -d whatsappcrm -c '\dt'
docker compose exec postgres psql -U whatsappcrm -d whatsappcrm \
  -c 'SELECT migration_name FROM _prisma_migrations;'
```

Port 5432 or 6379 already in use? Change `POSTGRES_PORT` / `REDIS_PORT` in `.env`, and the
matching port inside `DATABASE_URL` / `REDIS_URL` — they are separate values and both have
to move.

## Commands

Run from the repository root; Turborepo fans each one out across the workspaces.

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `pnpm dev`          | Runs the API and the frontend in watch mode         |
| `pnpm build`        | Builds every package                                |
| `pnpm typecheck`    | Type-checks every package                           |
| `pnpm test`         | Runs all tests — Jest for the API, Vitest elsewhere |
| `pnpm test:db`      | Integration tests that need a running database      |
| `pnpm lint`         | ESLint across the whole repository                  |
| `pnpm format`       | Applies Prettier                                    |
| `pnpm format:check` | Fails if anything is unformatted — what CI runs     |

**`test:db` goes through Turborepo like everything else**, and it has to: an
integration test that imports `@whatsappcrm/contracts` needs that package _built_, and
`dependsOn: ["^build", "generate"]` is the only thing that guarantees it. Running the
workspace script directly instead worked only as long as a previous `pnpm build` happened
to have left `packages/contracts/dist` on disk — which is true on a developer machine and
false in CI.

Two settings on that task are deliberate. It is **never cached**: its result depends on the
state of a real database, and replaying a cached pass against a different one would be a
green tick that means nothing. And it declares `passThroughEnv` for the connection URLs,
because Turborepo runs tasks with a filtered environment — without that,
`APP_DATABASE_URL=… pnpm test:db` would silently ignore the override and test the database
in `.env` instead.

### Database and queue

| Command                  | What it does                                                          |
| ------------------------ | --------------------------------------------------------------------- |
| `pnpm db:up`             | Starts PostgreSQL and Redis, returning once both are healthy          |
| `pnpm db:down`           | Stops both containers, **keeping** the data volumes                   |
| `pnpm db:logs`           | Tails container logs — slow queries land here (see below)             |
| `pnpm db:migrate`        | Creates and applies a migration from schema changes (local)           |
| `pnpm db:migrate:deploy` | Applies pending migrations without generating any (deploy path)       |
| `pnpm db:migrate:status` | Reports which migrations are applied and which are pending            |
| `pnpm db:reset`          | **Destructive.** Drops the local database and replays every migration |
| `pnpm db:seed`           | Loads the demo dataset — see [Seed data](#seed-data)                  |
| `pnpm db:studio`         | Opens Prisma Studio against the local database                        |
| `pnpm db:generate`       | Regenerates the Prisma client from `schema.prisma`                    |
| `pnpm db:roles`          | Creates the application roles and their grants — run after migrations |
| `pnpm db:roles:login`    | Gives those roles the throwaway local password                        |
| `pnpm db:roles:down`     | Removes those roles                                                   |
| `pnpm db:verify:rls`     | Proves two tenants cannot see each other's rows                       |
| `pnpm db:canary`         | Loads the small fixture the restore drill compares against            |
| `pnpm db:restore-drill`  | Dumps, restores into a scratch database, and diffs the two            |

`db:roles`, `db:roles:login`, `db:roles:down`, `db:verify:rls` and `db:canary` run
`psql` inside the Postgres container against `apps/api/prisma/sql`, which
`docker-compose.yml` mounts at `/sql`. They assume the default `whatsappcrm` user
and database; if you changed either in `.env`, run `psql` directly instead.

`pnpm db:restore-drill` is the one that proves a backup is a backup — it restores
into `whatsappcrm_restore_drill` and refuses any target not named that way, then
diffs the two databases down to the row-level security policy predicates. Run it
after a migration that adds a table, a policy or an extension. It needs no
PostgreSQL client tools installed: without `pg_dump` on `PATH` it runs the client
binaries in a container. Full cadence, and how to point it at a Render database:
[docs/runbooks/backups.md](docs/runbooks/backups.md).

`pnpm db:down` leaves your data in place. To throw it away as well —
`docker compose down -v`, which deletes the volumes and, on the next `pnpm db:up`,
re-runs the first-boot SQL in `docker/postgres/initdb.d`.

**`pnpm db:reset` has two guards, and both are deliberate.** In a non-interactive shell
it refuses to run and tells you to pass `--force`. And Prisma 7 detects AI coding agents
and blocks destructive commands outright unless `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`
is set to the text of the message in which you consented. Neither guard affects a human at
an interactive prompt; both will stop an agent, and any automated task that expects to
reset the database unattended. The route back to a known-good state that passes both
guards is
`docker compose down -v && pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login && pnpm db:seed`
— equally destructive, but it never invokes `migrate reset`. The two role steps are not
optional: `down -v` destroys the volume, and the roles live in the cluster it took with it.

`pnpm db:seed` is separately re-runnable and needs none of the above: it deletes its own
two tenants and writes them again.

## Working with the database

Postgres 16 and Redis 7 run from `docker-compose.yml`. Three details in there are
deliberate and worth knowing:

- The Postgres major matches Render's — `postgresMajorVersion: '16'` on all three managed
  databases in `render.yaml`. CI builds its database from the same Compose file, so a
  construct that needs a newer major fails in front of you rather than on Render's
  `preDeployCommand`. The two pins move together or not at all.
- Redis runs with `maxmemory-policy noeviction`, which **BullMQ requires** — under memory
  pressure any other policy lets Redis silently discard job data.
- Postgres logs any statement slower than 500 ms. `pnpm db:logs` is the fastest way to
  catch a bad plan before it reaches staging.

If your `pgdata` volume was created by the old Postgres 17 image, the 16 server refuses to
start against it — `database files are incompatible with server` in `pnpm db:logs`. A data
directory cannot be downgraded in place, and the volume holds nothing but local
development data, so throw it away and rebuild:
`docker compose down -v && pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login && pnpm db:seed`.

Connection details come from `.env` and are the same values Compose itself reads. The
password there is a throwaway for a container bound to localhost; it is not a secret and
must not be reused anywhere.

### The data model

`apps/api/prisma/schema.prisma` is the single source of truth for the database shape. It
expresses the entity table in `docs/architecture/0002-architecture-and-api-contract.md`
(TAR-39) — read that first for _why_ the entities are shaped this way; the schema file
carries the per-model reasoning next to each model.

Most models are tenant-scoped: they carry a non-null `tenant_id`, and row-level security
filters them. Five are not — `tenants`, `plans`, `webhook_events`, `tenant_signups` and
`lifecycle_events`, each deliberately, and
[the tenant isolation contract](docs/reference/tenancy.md#the-five-tables-with-no-rls-policy)
says what `TenantPrisma` does with each instead. Six conventions hold across every model,
starting with a non-null `tenant_id` on every scoped table and composite
`(tenant_id, <parent_id>)` foreign keys.

**[Data model reference](docs/reference/data-model.md)** — every entity, its constraints,
its load-bearing indexes and the story that owns it, plus the six conventions in full and
what TAR-52 changed about the WhatsApp entities.

### Tenant isolation

Isolation is enforced by the database, not by application code remembering a `where`
clause. All 38 tenant-scoped tables have `FORCE ROW LEVEL SECURITY` and one policy:

```sql
CREATE POLICY tenant_isolation ON conversations
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

`app.tenant_id` is a per-transaction setting the Prisma client extension sets before each
query. A connection that has not set it sees **nothing** — not everything. `FORCE` includes
the table owner, so migrations are not exempt. `WITH CHECK` means a cross-tenant write is
rejected rather than merely unreadable.

Two roles back it up, created by `apps/api/prisma/sql/app-roles.sql`:

| Role                 | Holds                                                | Sees                               |
| -------------------- | ---------------------------------------------------- | ---------------------------------- |
| `whatsappcrm_app`    | No `SUPERUSER`, no `BYPASSRLS`. DML on scoped tables | Only the tenant in `app.tenant_id` |
| `whatsappcrm_system` | The same, plus a `system_unrestricted` policy        | Everything — five call sites only  |

**`pnpm db:verify:rls` is the proof, not the documentation.** It creates two tenants,
reconnects so the connection has genuinely never set the GUC, and asserts that all 38 tables
return zero rows; that each tenant then sees its own rows and none of the other's; that a
cross-tenant insert is rejected and a cross-tenant update or delete matches nothing. It
reads the catalog rather than a list, exits non-zero on the first failure, and cleans up
after itself. CI runs it on every pull request. It writes to the database it is pointed at,
so point it at a local or disposable one.

**[Tenant isolation contract](docs/reference/tenancy.md)** — which client to inject,
`$tenantTransaction`, the three tables with no policy, the deactivation gate, the errors the
data layer throws, and the rules a new module has to follow.

### The two Prisma clients

`apps/api/src/prisma` exports two clients, and which one a class injects is a design
decision, not a convenience:

| Token           | Connects as          | Sees                                           |
| --------------- | -------------------- | ---------------------------------------------- |
| `TENANT_PRISMA` | `whatsappcrm_app`    | Only the tenant in the ambient request context |
| `SYSTEM_PRISMA` | `whatsappcrm_system` | Every tenant                                   |

```ts
constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}
```

`SystemPrisma` is a **separate client, not a flag** on the tenant one. A flag is one typo
away from being set, invisible at the injection site, and impossible to review by search; a
token appears in the constructor of every class allowed to use it. TAR-39 permits five such
classes — provisioning, login before a tenant is known, webhook ingest, the sweeper, and
platform reporting — and a sixth needs a justification in review.

`TenantPrisma` sets the GUC by wrapping every statement in a transaction, with TAR-51's
deactivation gate in front of it:

```sql
BEGIN;
SELECT set_config('app.tenant_id', assert_tenant_active($1), true);  -- true = transaction-local
<the query>;
COMMIT;
```

**No tenant in scope throws**, before anything is sent. Three things to know before writing
a query: it costs extra round trips, so use `prisma.$tenantTransaction(async (tx) => …)` for
multi-statement work; batch `$transaction([…])` does not work on it; and `tenants`, `plans`
and `webhook_events` have client-side rules because they carry no policy. The reference
covers each.

### Provisioning and deactivating tenants

Tenants are admin-provisioned; there is no self-signup. Both operations are one call,
authenticated by `PLATFORM_ADMIN_TOKEN` rather than by a session, and both are idempotent on
the tenant's slug.

`PLATFORM_ADMIN_TOKEN` holds `label:secret` entries, one per operator. What a caller
presents is the **secret** half; the label is what the audit trail records. The examples
below use `$PLATFORM_ADMIN_SECRET` for that half.

```bash
curl -X POST http://localhost:3001/api/v1/admin/tenants \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"acme","name":"Acme Ltd","timezone":"Europe/London","locale":"en-GB"}'

# 201 Created — 200 if it already existed
# {"id":"019fed83-ebd1-774d-86e4-46137546a539","slug":"acme","name":"Acme Ltd",
#  "status":"active","primaryHostname":"acme.app.localhost",
#  "settings":{"timezone":"Europe/London","locale":"en-GB"},"createdAt":"…"}

curl -X POST http://localhost:3001/api/v1/admin/tenants/acme/deactivate \
  -H "Authorization: Bearer $PLATFORM_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Non-payment, ticket OPS-412"}'

# 200 OK
# {"id":"019fed83-ebd1-774d-86e4-46137546a539","slug":"acme","name":"Acme Ltd",
#  "status":"suspended","suspendedAt":"…"}
```

Provisioning writes the tenant, its settings and its platform subdomain in one transaction,
and nothing else — no users, no branding, no subscription. The hostname is derived from the
slug and never taken from the request. Deactivation writes two columns and an audit entry:
the data is retained and reachable through `SystemPrisma`, while the tenant's agents stop
reaching it on their very next query, because the block lives in the database rather than in
a guard.

**[Platform admin API](docs/reference/admin-api.md)** — parameters, every response and error
shape, idempotency and retention semantics, and what each call deliberately leaves to
another story.

### Seed data

```bash
pnpm db:seed
```

Two tenants, reachable at `northwind.app.localhost` and `southwind.app.localhost`.
`northwind` is the one to work in: five agents across the three roles, two teams, two
WhatsApp numbers under two business accounts, five approved-and-pending templates, four
contacts, five threads and their messages, two tickets, and a subscription with usage
counters. `southwind` is small and exists to be **absent** — every list in the console is
served under row-level security, and a dropped tenant predicate is invisible in a database
holding one tenant. Its first message reads `SOUTHWIND ONLY —`, so a leak is something you
notice rather than something you have to query for.

Three things about how it is written are worth knowing before you change it:

- **It connects as `whatsappcrm_app`, not as the migration owner.** Locally the owner is a
  superuser and a superuser skips RLS entirely, so a seed written that way can happily
  write rows the application can then never read. Writing through `TenantPrisma` means a
  seed that finishes is evidence that the app role can read and write this data — and that
  a missing policy or a `pnpm db:roles` you forgot to re-run fails here rather than
  showing up later as an empty console. Only `tenants` and `plans` go through
  `SystemPrisma`, because neither carries a tenant policy.
- **Tenants come from `TenantProvisioningService`**, the same service behind
  `POST /api/v1/admin/tenants`. A seeded tenant is indistinguishable from a provisioned
  one, and there is no second way to create a tenant to keep in step with the first. The
  tenant id is therefore whatever provisioning assigned; every other id is a literal, and
  the user, team, contact and conversation ids are the ones
  `apps/web/lib/api/mock/fixtures.ts` already serves, so turning
  `NEXT_PUBLIC_USE_MOCK_API` off changes the transport and not the ids.
- **Timestamps are relative to the run.** Meta's 24-hour service window is a timestamp:
  fixed dates would leave every thread outside its window on a fresh seed, so the composer
  would be template-only and nobody could try a plain reply. One thread is left expired
  anyway, because that state has to be demonstrable too.

Re-running it deletes those two slugs — cascading through every tenant-scoped table — and
writes them again. It touches nothing else, so a scratch tenant of your own survives.
`plans` is upserted rather than replaced. It refuses to run under `NODE_ENV=production`
without `--force`, and prints the host and database it is about to write to before it
writes anything.

**It carries no credentials.** `POST /api/v1/auth/login` exists (TAR-56), but
`users.password_hash` is null on every seeded row, and a user with no password can never
sign in — so there is still nothing to sign in _with_. Setting one is invite acceptance's
job (TAR-55). Until that lands, `AUTH_STUB_ENABLED=true` and
`NEXT_PUBLIC_ENABLE_ROLE_STUB=true` — both already set in `.env.example`, so a
`cp .env.example .env` needs no edit — make the console resolve a real seeded user with the
role in the switcher, in the tenant the hostname resolves to. The per-WABA WhatsApp access
token is a placeholder encrypted at rest with the local key: enough for the connection to
read as connected, and rejected by Meta the moment anything tries to send with it, which
is the intended behaviour for a local stack.

`apps/api/src/seed/demo-dataset.ts` is the data; `seed.ts` is the mechanism. Editing the
dataset into a shape the database would reject is caught by `pnpm test` — the seed itself
only runs when somebody runs it, so its unit test is what stops a bad edit merging green.

### Adding a migration

Edit `apps/api/prisma/schema.prisma`, then:

```bash
pnpm db:migrate --name add_conversations
```

That writes `apps/api/prisma/migrations/<timestamp>_add_conversations/migration.sql` and
applies it. **Read the generated SQL before committing it** — Prisma will happily emit a
statement that rewrites a large table or takes a long lock, and neither is visible from
the schema diff.

**A migration that adds a tenant-scoped table has two more steps.** Prisma's schema
language cannot express row-level security, so nothing generates them:

1. Append the `ENABLE` / `FORCE` / `CREATE POLICY tenant_isolation` block to the
   migration, copying an entry from `20260810140000_tenant_isolation_rls`, and the
   matching `DROP POLICY` / `DISABLE` to its `down.sql`.
2. Re-run `pnpm db:roles`, which grants the new table to both roles and gives it its
   `system_unrestricted` policy.

Forgetting either fails `pnpm db:verify:rls` by name — it reads the catalog rather than a
list, so a new table with no policy is caught rather than assumed to be fine.

Step 2 is not a formality: until it runs, `whatsappcrm_app` holds **no privilege at all**
on the new table and every query against it fails with a permission error. That is
deliberate. The grant is automatic and the policy is hand-written, so letting the grant
arrive first would mean a forgotten step 1 ships a table every tenant can read instead of
one nobody can (TAR-95). A permission error on the first query is the cheap version of
that mistake.

**A partial index has no safety net, so write one.** Prisma cannot express
`CREATE INDEX … WHERE …`, and its Postgres describer skips indexes that carry a predicate
— so `migrate dev` will neither generate one nor propose to drop one it finds, and it
never shows up as drift. Convenient, but it means nothing regenerates the index from
`schema.prisma` and nothing notices if it disappears. Hand-write it in the migration, note
it in a comment on the model, and add a test that asserts the index definition —
`tickets_one_active_per_contact` and `src/prisma/ticket-active-uniqueness.int-spec.ts` are
the worked example. A missing unique index does not fail loudly; it silently starts
allowing duplicates.

**A migration that adds a function needs `pnpm db:roles` re-run too.** `app-roles.sql`
names each one, revokes the default `EXECUTE TO PUBLIC` and grants it to the two
application roles — so that a routine `REVOKE EXECUTE … FROM PUBLIC` hardening step is
survivable rather than an outage. Schema-qualify the call site (`public.my_function(…)`)
and pin the function's own `SET search_path`, per
`20260810170000_harden_tenant_deactivation_guard`.

**`@default(now())` is generated by the client, not the database.** Prisma 7 fills the
value in and sends it, so the `DEFAULT CURRENT_TIMESTAMP` in the DDL never fires and the
timestamp is the API process's clock at insert time rather than transaction start. It
does not matter for a single row. It does when two rows written together have to agree —
pass one `now()` read from the database explicitly to both, as
`TenantDeactivationService` does for `suspended_at` and its audit entry.

### Rolling a migration back

Prisma does not generate down migrations. Per
[ADR 0001](docs/adr/0001-stack-decision.md) (decision 6), **every migration directory
carries a hand-written `down.sql`** next to Prisma's `migration.sql`, reviewed like any
other code. Generate it _before_ running `pnpm db:migrate`, while the schema file holds
the new shape and the migrations directory still holds the old one:

```bash
cd apps/api
pnpm exec prisma migrate diff \
  --from-schema prisma/schema.prisma \
  --to-migrations prisma/migrations \
  --script > down.sql
```

Then move `down.sql` into the migration directory `pnpm db:migrate` creates, and read it
critically — the generated SQL is structurally correct but it is not a restore. A down
migration that drops a column or a table **destroys the data in it**. Where that is
unacceptable, the answer is not a better `down.sql`; it is the expand → migrate → contract
sequence, so the destructive step lands in its own separately deployable migration.

To apply one, against local or any other target:

```bash
pnpm --filter @whatsappcrm/api db:rollback            # prints the plan, changes nothing
pnpm --filter @whatsappcrm/api db:rollback --confirm  # runs it
```

That undoes the single most recently applied migration: it takes a Postgres advisory
lock so two runners cannot collide, then sends **the delete of that migration's
`_prisma_migrations` row and its `down.sql` as one statement batch**, so the schema
change and the bookkeeping land in a single transaction. Removing that row is the step
that is easy to forget by hand and that `migrate deploy` needs in order to re-apply the
migration afterwards. `DATABASE_URL` decides which database is affected, so export it
explicitly and read it back before adding `--confirm`. Locally, `pnpm db:reset` is often
the faster path.

**A `down.sql` may wrap itself in `BEGIN;` … `COMMIT;`, or manage no transaction at
all — but nothing in between.** Wrapping it is right when it will be applied by hand
through `psql`, which is in autocommit; about half the files here do. Both shapes stay
atomic under `db:rollback` because Postgres opens an implicit transaction block for a
multi-statement batch and a `BEGIN` inside one converts it rather than nesting. A file
that commits half-way through, or opens a second transaction, would leave the
bookkeeping delete outside the transaction that changed the schema —
`docs/runbooks/migrations.md` has the detail, and TAR-346 has the bug that came of
getting it wrong.

The convention is enforced, not just documented: `pnpm --filter @whatsappcrm/api
db:check-migrations` fails when a migration directory has no `down.sql`, or when its
transaction shape is not one of those two, and CI runs it on every pull request. A
convention nothing checks is a convention that lasts until the first busy afternoon.

The shadow database (`whatsappcrm_shadow`, created on the container's first boot) exists
only for the `migrate diff` above. Prisma wipes it on every use.

## Receiving WhatsApp webhooks

Two public routes, deliberately outside the `/api/v1` version prefix because the URL is
registered once inside Meta's dashboard:

```
GET  /api/webhooks/whatsapp   the verification handshake, performed once at registration
POST /api/webhooks/whatsapp   every inbound message and delivery receipt
```

Both are authenticated by cryptography rather than by a session — there is no guard, and
none should be added. `GET` compares `hub.verify_token` against
`WHATSAPP_WEBHOOK_VERIFY_TOKEN` in constant time and echoes `hub.challenge` only on a
match. `POST` verifies `X-Hub-Signature-256`, an HMAC-SHA256 of the **raw** body under
`WHATSAPP_APP_SECRET`. Unset either variable and the corresponding route refuses
everything; that is the intended default for an environment that was never given the
secret.

Try it locally with the placeholders `.env.example` ships:

```bash
# The handshake. Echoes the challenge verbatim, as text/plain.
curl "http://localhost:3001/api/webhooks/whatsapp?hub.mode=subscribe\
&hub.verify_token=local_dev_only_verify_token_not_a_secret&hub.challenge=echo-me"
# echo-me

# A delivery. The signature is over the exact bytes, so sign the file you send.
BODY='{"object":"whatsapp_business_account","entry":[]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac \
  local_dev_only_meta_app_secret_not_a_secret -hex | awk '{print $2}')
curl -X POST http://localhost:3001/api/webhooks/whatsapp \
  -H 'Content-Type: application/json' -H "X-Hub-Signature-256: sha256=$SIG" -d "$BODY"
# 200, empty body
```

### What happens after the 200

The `200` means **stored**, not **processed**. The controller writes the raw payload to
`webhook_events` and answers; a BullMQ job then routes it. That order is the durability
rule from ADR 0001: Meta retries with backoff and eventually gives up, so enqueueing
straight to Redis would turn a Redis outage into permanent message loss. Writing to
Postgres first makes Redis a latency dependency instead of a durability one.

The worker resolves `phone_number_id` → `whatsapp_accounts` → the owning tenant, opens a
tenant context scope, and upserts the contact, the conversation and the message through
`TenantPrisma`. Every write is idempotent and order-independent: threads sort by the
provider's `sent_at`, `last_message_at` only moves forward, and a message status only ever
advances, so a late `sent` webhook cannot un-read a message.

**Nothing is ever dropped.** An event that cannot be applied is parked `failed` with its
payload intact and a reason an operator can group by:

```sql
SELECT split_part(last_error, ':', 1) AS reason, count(*)
FROM webhook_events WHERE status = 'failed' GROUP BY 1;
--  unknown_phone_number_id | 3      a number connected before its tenant existed
--  payload_unrecognised    | 1      signed by Meta, but not a shape we parse
--  tenant_not_active       | 2      deactivated tenant; replayable if it returns
```

Replaying one is a deliberate operator act, not a re-enqueue: a parked row is not
claimable, so a job that named it would no-op. Reset it and the next sweep collects it.

```sql
UPDATE webhook_events
   SET status = 'received', attempts = 0, last_error = NULL
 WHERE id = '<event id>' AND status = 'failed';
```

A repeatable sweep re-enqueues anything still `received`, or stuck in `processing`, past
`WEBHOOK_STUCK_AFTER_MS`. That job is what converts a Redis outage into message
_lateness_ rather than message _loss_, so an inbox that has stopped updating usually needs
Redis looked at rather than anything replayed by hand. `webhook_events` in `received`
older than five minutes is the condition worth alerting on.

Without `REDIS_URL` the API still boots and still accepts and stores deliveries — it logs
a warning at startup and nothing processes them until a worker exists.

## Media

Both directions go through `MediaModule`, and both store the bytes in one place.

**Inbound.** A media message arrives as a _handle_, not a file, and Meta's URL for it
expires five minutes after it is issued. The ingest transaction records a
`message_attachments` row as `pending` — the durable statement that bytes are owed — and
queues a download on the `media` queue. The worker resolves the handle, streams the object
into storage, verifies it against the digest Meta published, and flips the row to `stored`
with a `/api/v1/media/{id}/content` path on it. A permanent refusal parks the row `failed`
with the reason; the message stays in the thread either way, because the customer did send
something.

Downloading is a job rather than part of ingest deliberately: it is two more network calls
and up to 100 MB, and doing it inline would put the whole inbox behind the slowest
customer's video. The visible consequence is that a message can reach an agent before its
picture does, which is why `downloadState` is published.

**Outbound.** `POST /api/v1/media` takes a multipart `file`, validates it, stores it, and
returns `{ mediaId }`. Validation is by the **bytes**, not by the declared media type: a
signature check resolves what the file actually is, the per-kind ceiling from
`WHATSAPP_MEDIA_LIMITS` is applied to _that_ kind, and a mismatch or an unsupported type is
refused with `validation_failed` — oversize with `payload_too_large`. At send time the
bytes are uploaded to Meta and its handle is used immediately; nothing caches one, because
a Meta handle is per phone number and expires on Meta's schedule.

```bash
curl -X POST http://localhost:3001/api/v1/media -F file=@invoice.pdf
# 201 { "mediaId": "0198f0..." }
```

**Storage is a port with one adapter, and that is a known gap.** ADR 0001 took no decision
on object storage and TAR-41 has not provisioned any, so `MediaStorage` ships with a
filesystem adapter rooted at `MEDIA_STORAGE_ROOT`.

> ⚠️ In a deployed environment that path **must be a durable, shared volume**, given as an
> absolute path. A container's writable layer is neither: media written there is gone on
> the next deploy while the rows naming it survive, and a second replica cannot read what
> the first wrote. It holds customer data, so back it up and control access to it like the
> database. Locally it defaults to a git-ignored `.media-storage/` at the repository root.

Nothing is ever served from a client-supplied path. A caller names a media **id**; the
lookup goes through `TenantPrisma`, and the storage key is read off the row that resolved.
Another tenant's id is `not_found`, never `forbidden` — a 403 would confirm it exists.

## Invitations

How somebody who has never signed in gets an account. `IdentityModule` owns it, against
the contract in
[ADR 0005](docs/architecture/0005-auth-session-and-invite-contract.md). Login, password
reset and the global auth guard have since landed alongside it; what an account can do once
it exists is [Managing agents, teams and roles](#managing-agents-teams-and-roles).

```
POST   /api/v1/users/invites            user:invite   201 created · 200 refreshed
GET    /api/v1/users/invites            user:read     ?status=pending|accepted|revoked|expired
POST   /api/v1/users/invites/{id}/resend  user:invite
DELETE /api/v1/users/invites/{id}       user:invite   204
POST   /api/v1/invites/lookup           public        what the accept screen renders
POST   /api/v1/invites/accept           public        sets the session cookie
```

**Re-inviting an address is never an error.** `invites_one_live_per_email` is a partial
unique index and cannot carry an expiry term — Postgres requires an index predicate to be
`IMMUTABLE` — so a lapsed invitation still occupies it. Creating one is therefore an
upsert: the same row, a new token, a new expiry, and the role and teams the admin just
asked for. Only an address that already has a usable account is a `conflict`. The reply is
`201` when a row was written and `200` when one was refreshed.

**The token is a credential and is treated as one.** 32 random bytes, mailed once, stored
only as its SHA-256 digest, and single-use because acceptance is a conditional
`UPDATE … WHERE accepted_at IS NULL … RETURNING` — two people clicking the same link means
the second one updates no rows. The emailed link carries it in the URL **fragment**
(`https://{tenant host}/invite#token=…`), which browsers never send to a server, so it stays
out of access logs and `Referer` headers. The host comes from `tenant_domains`, never from
the request `Host`, which an attacker chooses.

**Nothing about the acceptance comes from the request.** The body is a token, a display
name and a password. The tenant is the one the hostname resolved to and the role is the one
on the invitation, so there is no field to tamper with; a token issued by one tenant and
presented at another's address matches zero rows under RLS.

**Trying it locally.** No mail provider has been chosen yet (ADR 0005, open question 2), so
outside production `ConsoleMailer` prints the rendered link to the API log and you click it
from there. In production `UndeliverableMailer` drops the message and logs that it did —
loudly, and without the token — until TAR-41 wires a real adapter.

```bash
# as an admin, against a seeded tenant (AUTH_STUB_ENABLED=true)
curl -X POST http://northwind.app.localhost:3001/api/v1/users/invites \
  -H 'content-type: application/json' -H 'x-dev-role: admin' \
  -d '{"email":"newhire@northwind.example","role":"agent"}'

# the link is in the API log; take the fragment from it
curl -X POST http://northwind.app.localhost:3001/api/v1/invites/accept \
  -H 'content-type: application/json' \
  -d '{"token":"…","displayName":"New Hire","password":"a-long-enough-password"}'
```

Passwords are argon2id (`m=19456 KiB, t=2, p=1`), stored as the PHC string so the
parameters travel with the hash and can be raised without a migration. The session cookie
is `__Host-wac_session`; set `SESSION_COOKIE_SECURE=false` for plain-HTTP local
development, which drops the prefix and `Secure` — the API refuses to boot with it off
under `NODE_ENV=production`.

## Managing agents, teams and roles

What a tenant admin does after the invitations go out. The full HTTP surface — every
parameter, every error, the invariants and the audit trail — is
[the people and teams API reference](docs/reference/people-api.md); this is the short
version.

**Three roles ship**, and they are tenant-scoped. There is no cross-tenant role.

| Role         | What it can do                                                                      |
| ------------ | ----------------------------------------------------------------------------------- |
| `agent`      | Their own and their teams' conversations. No workspace settings                     |
| `supervisor` | Every conversation in the tenant, plus assignment, teams, and inviting agents       |
| `admin`      | Full tenant scope, including role assignment, removal, billing and channel settings |

A role is only a bundle of permissions. `ROLE_PERMISSIONS` in
`packages/contracts/src/rbac.ts` is the single place a role is ever interpreted — guards,
the console and the tests all read it, so a change to the matrix is a change to that file
and nothing else.

### In the console

**Settings → People**, at `/settings/people`. Two tabs:

- **Agents** — _Invite agent_ takes an email, a role and any teams; the invitee picks their
  own password from the emailed link. _Edit_ changes a display name, role, teams or status.
  _Remove_ revokes access immediately and leaves their conversations unassigned.
- **Teams** — _Create team_ takes a name, an optional description and its members. Editing a
  team replaces its membership rather than merging.

Supervisors see the same screens with the role controls disabled and no _Remove_ action.
Agents get no Settings entry in the navigation at all — and that is presentation, not
access control: a server action asserts the permission again, and the API asserts it a
third time.

### Over the API

```bash
# every role — the people list is tenant-wide
curl -b cookies.txt 'http://northwind.app.localhost:3001/api/v1/users?limit=25'

# admin — promote somebody and set their teams in one call
curl -X PATCH -b cookies.txt -H 'content-type: application/json' \
  -d '{"role":"supervisor","teamIds":["0192f002-0000-7000-8000-000000000201"]}' \
  http://northwind.app.localhost:3001/api/v1/users/0192f001-0000-7000-8000-000000000101

# supervisor or admin — create a team with its members
curl -X POST -b cookies.txt -H 'content-type: application/json' \
  -d '{"name":"Retention","memberUserIds":["0192f001-0000-7000-8000-000000000101"]}' \
  http://northwind.app.localhost:3001/api/v1/teams
```

Four rules are worth knowing before you drive any of this, because each one answers with a
refusal rather than a surprise:

- **Assigning a role needs `user:set_role`, which only an admin holds.** A supervisor may
  change a person's name, status and teams, and may invite an agent — not promote anyone.
  Without that split, `user:update` would let a supervisor promote themselves.
- **Nobody changes their own role**, admins included, so every escalation involves a second
  person.
- **The last active admin cannot be demoted, suspended or removed.** `409
last_admin_required` — a tenant with no admin can only be recovered by platform support.
- **Removal is a soft delete.** `DELETE /api/v1/users/{id}` sets `status: "removed"`, kills
  the sessions, clears every routing reference and revokes any live invitation, while
  keeping the messages, notes and audit rows that name them attributable.

**A change takes effect on the next request, not the next login.** Role, status and team
membership are materialised onto the session principal, so any change to them revokes that
person's sessions in the same transaction. Their next call is a `401`.

## Environments

Three hosted environments — development, staging and production — each with its own
database, its own Key Value instance and its own WhatsApp and Polar credentials. They are
defined as a Render blueprint in [`render.yaml`](render.yaml); provisioning them, the
secrets you are prompted for, and the alerting wired to them are in
[`docs/runbooks/environments.md`](docs/runbooks/environments.md).

Health, deliberately split:

| Endpoint            | Answers                           |
| ------------------- | --------------------------------- |
| `/api/health`       | is the process alive              |
| `/api/health/ready` | can it serve — database and queue |

`/api/health/ready` answers `503` when a dependency is down and still returns the full
body, so an alert names the failing dependency rather than only saying something is wrong.
It is the health check path on every deployed API service. Both are `VERSION_NEUTRAL`.

**Migrations apply automatically.** Each environment runs `pnpm db:migrate:deploy` as a
pre-deploy hook, followed by `db:provision-roles` — the deployed equivalent of
`pnpm db:roles`, which only reaches a local container. Both run from the same build that
produced the code, before the new instance serves traffic; a failure aborts the deploy and
the previous instance keeps serving.

Services start with `exec node <entrypoint>`, never a package script. That is
load-bearing: `exec` makes node PID 1 so `SIGTERM` reaches the shutdown hooks. Through
`pnpm start` the signal is swallowed and the process is killed outright, cutting in-flight
requests and discarding buffered error-tracker events on every deploy.

## Continuous integration

`.github/workflows/ci.yml` runs four jobs — **Lint**, **Type-check**, **Test** and
**Database** — on every push to `main` and every pull request targeting it. They are the
commands above, so a run that is green locally is green in CI. **Database** starts the
Compose stack, applies the migrations, creates the roles, and then proves tenant isolation
twice — `pnpm db:verify:rls` in SQL and `pnpm test:db` through `TenantPrisma`; isolation is
a property of the database rather than of any one function, so a unit test cannot assert
it. Every job also seeds `.env` from `.env.example` and runs `pnpm db:generate`, because
the Prisma client is generated rather than committed. **Lint** covers both
`pnpm format:check` and
`pnpm lint`, in that order: Prettier owns formatting and ESLint owns everything else, per
ADR 0001's decision 12. An unformatted file therefore fails the **Lint** check — run
`pnpm format` and push again.

`main` is protected, and **Lint**, **Type-check**, **Test** and **Database** are all
**required** — they gate the merge rather than merely reporting on it. **Database** joined
that list in TAR-96: it is the only check that proves tenant isolation, so leaving it
advisory meant a broken policy could go red and merge anyway. The branch must also be up
to date with `main` before merging, review threads must be resolved, administrators are
included, and force pushes and branch deletion are blocked.

In practice that means every change lands through a pull request: a direct push to `main`
is rejected with `GH006: Protected branch update failed`, because the commit being pushed
carries no passing checks. Renaming a job in the workflow renames its required check and
silently removes the gate, so update the protection rule in the same change.

### Landing a pull request

Do not merge by hand, and do not wait to be asked for a rebase. A pull request opened from
an `agent/` branch against `main` opts itself into auto-merge as soon as it is ready for
review — `.github/workflows/pr-enable-automerge.yml` does it, so there is nothing to
remember. Open the pull request, mark it ready, and stop watching it.

That used to be each agent's own job, and it did not hold: when TAR-446 was investigated,
all 12 open pull requests had `autoMerge=false`, so the sweep below skipped every one of
them and the rebase loop carried on. If you ever need to arm it by hand — a branch outside
`agent/`, or a run where the workflow warned — it is still one command:

```bash
gh pr merge --auto --squash
```

GitHub then merges it by itself the moment the four checks are green and the branch is up
to date with `main`.

The second half of that condition is the one that used to cost everybody time. With this
many pull requests open at once, `main` moves every few minutes, so a branch that was up
to date when its checks started is `BEHIND` by the time they finish — and auto-merge, on
its own, does **not** refresh a branch that has fallen behind. It just waits. That is what
produced the loop TAR-446 was opened for: somebody had to notice each stale pull request
and ask its author to rebase, repeatedly, faster than merges were landing.

`.github/workflows/pr-autoupdate.yml` closes that gap. On every push to `main` — and
again the moment a pull request opts in — it merges `main` into every open pull request
that is waiting to auto-merge, which reruns the required checks against what is now on
`main`. Green plus up to date is what auto-merge wants, so it lands the pull request
unattended. Branches without auto-merge enabled are left alone — asking for auto-merge is
what opts a branch into being kept fresh.

Both triggers matter. Without the second, a pull request that asks for auto-merge while it
is _already_ behind would wait for the next push to `main` to be noticed — and when nothing
else is in flight, that push is the one it is itself trying to make.

A merge queue would be the natural fix and is deliberately not used here: it is an
organization-owned-repository feature, and this repository belongs to a user account, so
the rulesets API refuses the rule (`Invalid rule 'merge_queue'`). If this repository ever
moves to an organization, replace this workflow with a queue and add `merge_group:` to
`ci.yml`'s triggers.

Two consequences worth knowing. The sweep needs `AUTOMERGE_TOKEN` — a fine-grained
personal access token scoped to this repository with **Contents: read and write** and
**Pull requests: read and write**, set under _Settings → Secrets and variables → Actions_.
It cannot use the built-in `GITHUB_TOKEN`, because GitHub does not start workflows for
pushes made with it, and a branch refreshed without rerunning its checks would carry green
checks belonging to its previous head. Without the secret the sweep logs a warning and
does nothing. And because every merge to `main` refreshes the pull requests queued behind
it, each one costs a CI run per merge that lands ahead of it — the same runs the manual
rebase loop was already paying for, minus the waiting.

A branch that genuinely conflicts with `main` is reported in the run summary and left
alone; no API call can resolve that, so its owner has to.

Resolving that conflict is also what re-arms the pull request, and for a while it did not.
GitHub does not start `pull_request` workflows for a pull request whose merge ref it cannot
build, and it cannot build one while the branch conflicts — so a pull request that opens
`CONFLICTING` never gets an `opened` run, and never gets armed. Fixing the conflict is a
force-push, which delivers only `synchronize`. Until TAR-516 that event was not in
`pr-enable-automerge.yml`'s trigger list, so the two composed into a dead end: a conflicting
agent pull request could never re-arm itself by being fixed, which is exactly the case the
workflow exists for. #198 sat `MERGEABLE`, `CLEAN` and fully green with no auto-merge and no
way back into the pipeline.

`synchronize` is in that list now, with one restriction: on a push it arms only a pull
request the timeline shows has **never** been armed. A pull request that was armed and is
not armed now is one somebody turned off deliberately, and pushing to it is not a request to
turn it back on. So the recovery works without taking that decision away from you — and if
you do want a pull request to stop auto-merging, `gh pr merge --disable-auto` still holds.

Lint runs `typescript-eslint`'s type-aware rules, which has two consequences worth
knowing. Every linted TypeScript file needs a `tsconfig` that covers it — a new `.ts`
file outside one fails lint with a parsing error rather than being silently skipped. And
the rules resolve `@whatsappcrm/contracts` through its build output, so `pnpm lint`
builds `packages/*` first; without that, a clean checkout lints an unresolved type as
`any` and reports errors that do not exist.

## Configuration

`.env.example` is the documented contract for every environment variable and is the file
to update when a key is added. It carries **no secrets** — the only values in it are local
Docker defaults, and deployed environments read everything from the platform's secret
store, never from a committed file.

For the API, `.env.example` must stay in sync with
`apps/api/src/config/env.schema.ts`, which validates the environment at boot and refuses
to start if a required key is missing or malformed. `DATABASE_URL` and `REDIS_URL` are
still optional there — the scaffold boots without them — and TAR-41 promotes both to
required. For the console, the matching file is `apps/web/lib/config/env.ts`.

**Declare every key exactly once.** Every reader of this format — Node's `loadEnvFile`,
dotenv, Docker Compose — takes the _last_ occurrence of a key, so a second `KEY=` further
down the file silently blanks the value set above it rather than being ignored as a
duplicate. That is not hypothetical: `WHATSAPP_APP_SECRET` and
`WHATSAPP_WEBHOOK_VERIFY_TOKEN` were declared twice, and the empty second pair won, so
`cp .env.example .env` left the webhook route refusing every delivery (TAR-146).

`PLATFORM_ADMIN_TOKEN` is optional in a different sense: leaving it unset does not disable
validation, it disables the whole platform admin surface. Every request to
`/api/v1/admin/*` is refused, which is the safe default for routes that create tenants.
It holds comma-separated `label:secret` entries — one per operator or automation — so the
audit trail can name which credential acted; generate each secret with
`openssl rand -base64 48` and keep them in the secret store. A **malformed** value is not
optional in either sense: an unlabelled entry, a short secret or a repeated label fails the
boot, so upgrading past TAR-166 means updating every environment holding this variable in
the same release.

`WHATSAPP_APP_SECRET` and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` are optional in exactly the same
sense, and for a sharper reason: the webhook route is public and unauthenticated, so an
environment with no app secret must refuse every delivery rather than accept unsigned
ones. Both are platform-level and come from the Meta app dashboard — one Meta app serves
every tenant, and tenant routing is `phone_number_id` → `whatsapp_accounts`, never a
per-tenant secret.

`MEDIA_STORAGE_ROOT` is required with a local default, and it is the one variable in this
file whose default is actively wrong in production: point it at a durable, shared volume
using an absolute path, for the reasons in [Media](#media) above.

The Prisma CLI reads its own configuration from `apps/api/prisma.config.mjs`, which loads
the repository-root `.env`. Prisma 7 does not load `.env` on its own and no longer accepts
`url = env(...)` inside the schema, so that file is the single place the CLI learns where
the database is. A variable already set in the real environment wins over the file, which
is what makes `DATABASE_URL=… pnpm db:migrate:deploy` work against any target.

**One root `.env` serves both apps, and each one reaches it deliberately.** Next only
auto-loads `.env` files sitting beside the app it serves, so `apps/web/next.config.mjs`
loads the root file through `apps/web/repository-env-file.mjs`, the same way
`apps/api/src/repository-env-file.ts` does for the API. Without it a setup that followed
step 2 above still left the frontend with no `TRUSTED_PROXY_SECRET`, and every browser call
through the `/api/*` rewrite answered `tenant_not_found` — a backend-looking failure with a
frontend cause (TAR-164). The same precedence applies as above: a variable already set in
the real environment wins, so Render, which sets each service's variables directly, is
untouched by this.

## Conventions worth knowing before you write code

- **Tenant scoping goes through `TenantContextService`**
  (`apps/api/src/common/tenant-context/`). It is an `AsyncLocalStorage` scope that works
  in HTTP requests, queue workers and WebSocket handlers alike. Do not build a second
  mechanism. Use `requireTenantId()` wherever a missing tenant is a bug — it throws
  rather than letting an unscoped query run.
- **Shared types live in `packages/contracts`.** If the API and the frontend both need to
  know a shape, it is a Zod schema there, not a duplicated interface.
- **Errors have one envelope** (`ApiErrorSchema`), and the frontend has one error type
  (`ApiRequestError` in `apps/web/lib/api/http.ts`). Every response carries `x-request-id`,
  which ties a user-reported error to a log line.

## Frontend

`apps/web` is a Next.js App Router console. Data is read in server components and written
through server actions, so no list in the app pays for a client-side fetch waterfall and
every permission decision happens where the session lives.

### Design tokens — every project is a theme

**What the tokens equal, and the layouts they build, is
[the visual design language](docs/design/0001-visual-design-language.md).** Read it before
building a screen; this section is only the mechanism.

Three layers, and the direction is one-way:

| Layer     | File                           | Contains                                                               |
| --------- | ------------------------------ | ---------------------------------------------------------------------- |
| Primitive | `styles/tokens/primitives.css` | Raw scales: palette, spacing, type, radii, shadows, motion, z-index    |
| Semantic  | `styles/tokens/semantic.css`   | Role names: `--color-surface`, `--space-4`, `--radius-md`, `--z-modal` |
| Base      | `styles/base.css`              | Reset, base element styles, the one focus ring                         |

**Components read semantic tokens only.** They never reference a primitive and never
contain a raw colour, px value, duration or z-index. Dark mode re-declares the same
semantic names under `[data-theme='dark']`, so swapping the whole visual identity means
editing two files and no components. `prefers-reduced-motion` is handled once, in the token
layer, by collapsing the duration tokens.

The theme is resolved on the server from the `wac_theme` cookie and rendered into
`<html data-theme>` in the first response — so a reload paints the right theme on the first
frame with no flash and nothing to correct after hydration. The navigation rail's collapsed
width works the same way, from `wac_rail`.

Two contrast rules worth knowing: `--color-on-surface-muted` is the darkest muted role that
clears WCAG AA (4.5:1) in both themes and is what secondary text uses;
`--color-on-surface-subtle` is around 2.6:1 and is **decoration only** — never put text on it.

### Styling

CSS Modules, colocated with the component, semantic class names. No inline style objects for
static styling, no utility classes, no CSS-in-JS. Global CSS is limited to
`app/globals.css`, which imports the three layers above and nothing else.

Dynamic state is a `data-` attribute or a module class toggle (`cx()` in `lib/cx.ts`), never
a concatenated class string. Layout uses logical properties (`margin-inline-start`,
`inset-inline-end`) so RTL works without a second stylesheet.

### Adding a component, with its skeleton

1. **Look for an existing one first.** `components/ui/` holds the domain-free primitives.
   Extend one with a `variant`/`size`/`tone` prop before forking a near-duplicate.
2. Colocate `Component.tsx` + `Component.module.css` (+ `Component.test.tsx`). One component
   per file, named the same as the file.
3. Copy goes in `content/en.ts` and is read through `useContent()`. Route paths come from
   `lib/routes.ts`. Neither belongs inline. Anything `Intl` _phrases_ rather than translates —
   a list, a plural, a date — takes its locale from `content.locale`, never from the browser,
   so the server and the client format identically.
4. **Export the skeleton from the same file**, as `ComponentSkeleton`. Build it from the
   _same_ structure as the real thing — reuse the same layout primitives and column
   metadata rather than hand-drawing boxes. `AgentsTable` and `AgentsTableSkeleton` both
   build from `agent-columns.ts` for exactly this reason: adding a column cannot leave the
   skeleton behind.
5. Skeleton nodes are `aria-hidden`; the region announces itself once through
   `<LoadingAnnouncement />`.
6. If the component is not above the fold, put it behind `next/dynamic` with its own
   skeleton as the `loading` fallback, and wrap it in `<LazyBoundary>`.

Primitives never import from `features/`. Features may import primitives.

### Loading, error and empty states

Every async region gets a structure-matching skeleton — never a bare spinner, never a blank
gap. Spinners are allowed only for a button's own pending state (`<Button isPending>`).

- Route level: `loading.tsx` composed from the page's section skeletons, `error.tsx` for the
  route boundary.
- Section level: `<Suspense>` with that section's skeleton, inside a
  `<SectionErrorBoundary>` so one broken widget cannot blank the page. That boundary also
  detects a chunk-load failure after a deploy and offers a reload rather than a retry that
  can never succeed.
- Empty and error use the shared `EmptyState` / `ErrorState`, sized like the content they
  replace.

### Realtime: the console refetches, it never patches

The shared inbox stays current over TAR-69's Socket.IO gateway, and the rule is one line:
**an event is a signal to refetch, never state to apply.** `lib/realtime/inbox-events.ts`
maps a `ServerEvent` onto `refetch`, `signed-out` or `ignore`, and a `refetch` is a
debounced `router.refresh()` — a server render that re-runs the same visibility rules the
API enforces. So a thread that changes hands cannot leave a stale copy on screen, and a
missed event is recovered by the next refetch rather than by a replay the protocol does not
offer. Every reconnect refetches first, which is the whole of the "no stale or missing
messages after a dropped socket" guarantee.

Three things about the connection are deliberate and easy to undo by accident:

- **The handshake credential is a single-use ticket**, fetched from
  `POST /api/v1/auth/realtime-ticket` immediately before connecting, because the session
  cookie is third-party to the realtime origin under a white-label domain and would be
  dropped. It lives about a minute.
- **Socket.IO's own reconnection is off** (`reconnection: false`). It would replay a spent
  ticket and be refused for ever, looking like a socket that is retrying while it can never
  succeed. `lib/realtime/useInboxRealtime.ts` mints a fresh ticket per attempt, on the
  capped backoff with jitter in `reconnect-delay.ts`.
- **`socket.io-client` is imported dynamically**, so it lands in its own chunk and never
  enters a route's initial JavaScript. The page is server-rendered and fully usable before
  it loads.

The socket is disabled under `NEXT_PUBLIC_USE_MOCK_API`, which has no server behind it.

### Sending a message: the composer

`features/inbox/components/MessageComposer.tsx` sits at the foot of the thread and has two
modes, because WhatsApp does. Inside Meta's 24-hour customer service window an agent writes
what they like; outside it, only a template the business had approved in advance. Four
things about it are load-bearing.

**`null` is a closed window, not an unknown one.** `features/inbox/service-window.ts` mirrors
the API's `isServiceWindowOpen` exactly — a `null` `serviceWindowExpiresAt` and an expiry in
the past mean the same thing, and the boundary is exclusive. Two clocks that disagreed would
mean a console offering a send the API refuses.

**The window is a prop _and_ a hook.** `ThreadSection` evaluates it on the server and passes
`initialWindow` down, so the first client render matches the markup that arrived; deciding it
during render from `Date.now()` is a hydration mismatch. `useServiceWindow` then owns it and
schedules a timer for the exact moment it shuts, so an agent part-way through a reply sees the
composer switch — with the draft intact — rather than discovering it by pressing Send. A
toast fires on that edge only.

**Every send carries an `Idempotency-Key`, keyed on the draft and retired on success.** The
API replays an identical request under the same key and refuses a _different_ body under it as
`idempotency_key_reused`, so `useIdempotencyKey` mints one per payload: a double-click and a
retry after a network drop share a key and deduplicate, while an edited draft gets a fresh one.
A key that never changed would block somebody fixing a typo; a key minted per click would send
twice.

The `retire()` on success is the other half, and it is not optional. The draft clears when a
send lands, but the _next_ identical reply hashes to the same signature — so without it, `ok`
twice in a row reuses a key that already delivered, the API replays the first send's 201, and
the customer receives nothing while the console shows "Message sent". Keys live 24 hours.
Every caller clears the ledger on success; nothing clears it on failure, because retrying the
same draft onto the same key is exactly what idempotency is for.

**Media uploads leave from the browser, not from a server action.** `lib/api/media-browser.ts`
posts multipart to the same-origin `/api` proxy. Everything else in `lib/api` runs on the Next
process — this cannot, because WhatsApp's document ceiling is 100 MB and a server action
buffers its body in the console's memory to move bytes that are going to the API anyway. The
file is checked against the contract's `WHATSAPP_MEDIA_LIMITS` _before_ the upload, and the
upload happens on pick rather than on send, so Send stays a small JSON call.

Template filling lives in `features/inbox/template-draft.ts`. It decides arity and headers
before the send, so the Send button never reaches a `whatsapp_template_invalid`, and it renders
the preview through the contract's own `renderTemplateBody` — the same function the API stores
on the message row, so the sentence an agent approves is the sentence the record shows. The
picker itself is behind `next/dynamic`: most replies are free-form, and a tenant's approved
template set has no business in the inbox's initial JavaScript.

### Routing rules: the order is the meaning

`/settings/assignment` carries two unrelated halves, gated and streamed separately: the
workload report, and the routing-rule builder in `features/routing-rules/`. A principal
holding only `report:read_all` sees the report and no rule list at all — the rules need
`assignment_rule:read`, which
[ADR 0007](docs/architecture/0007-routing-rules-and-assignment-fallback.md) assigns instead
of the admin-only `channel:manage`, so routing stays in a supervisor's hands.

Three things about the surface are decided by that contract rather than by taste:

- **Rules are an `<ol>`, not a table.** They are evaluated top-first and the first match
  wins, so the order _is_ the data; an ordered list says that to a screen reader without a
  column for it. Reordering is two buttons per row, not drag-and-drop — TAR-24 puts a canvas
  out of scope, and buttons are keyboard-operable for free.
- **Reorder sends the whole set, and nothing is optimistic.** `POST /assignment-rules/reorder`
  takes the tenant's complete rule set, which is also its optimistic concurrency: a set that
  no longer matches the server's means somebody else edited the list, and the answer is
  `conflict` rather than a partial reorder. Showing a reordering that the engine is not
  actually using would be worse than a round trip.
- **A rule can outlive its target.** Removing an agent clears `target_user_id` and leaves the
  rule inactive, so the supervisor finds a rule needing a new target instead of finding it
  gone. The list renders that state explicitly and refuses to offer the on switch until a
  target is chosen — the API refuses it too.

`lib/api/contact-schema.ts` reads the tags and custom-field definitions the condition builder
offers. ⚠️ Both shapes are in the merged contract but **neither endpoint is in TAR-39's
published table yet** — `ContactsModule` owns them and TAR-33 builds their editors — so a
`not_found`, and only a `not_found`, is read as "this workspace has no vocabulary yet". Every
other status still reaches the section's error boundary.

**What the list does not show is the other half of routing.** A ticket that matches no rule
is not left alone: it goes to round-robin/load-based rotation (TAR-23), and if rotation has
nobody free it stays unassigned and surfaces under **Flagged for you** on the same page. The
endpoints, the condition grammar and the whole evaluation path are in
[the assignment rules API reference](docs/reference/assignment-rules-api.md), and rotation's
own half — eligibility, the selection order, the workload caps and the three deferral reasons
— is [the auto-assignment reference](docs/reference/auto-assignment.md). The supervisor's
versions are [Route new tickets to the right team](docs/guides/route-new-tickets-with-rules.md)
and [Clear tickets nobody could take](docs/guides/clear-flagged-tickets.md).

### Workflows: the same list shape, and every match runs

`/settings/workflows` (TAR-396) renders the tenant's workflows as an ordered rule list, and
it deliberately does **not** reuse the routing-rule copy. A routing rule decides where a
conversation goes and the first match wins; a workflow writes to a ticket that already
exists, and **every** matching workflow runs. Sharing the vocabulary would flatten a
difference a supervisor has to understand, so `content.workflows` is its own block in
`apps/web/content/en.ts`.

The builder's option lists come from `GET /api/v1/workflow-catalog` rather than from a
transcribed constant, so the console cannot offer an action the API would refuse. The
taxonomy behind the pickers — tags, teams, agents — is read live on every render and never
cached beside the workflow: a definition stores ids only, and the response resolves names at
read time, so renaming a team needs no republish and a deleted one renders as visibly broken.

The endpoints, the grammar and the exactly-once claim are in
[the workflow automation API reference](docs/reference/workflows-api.md); the supervisor's
version is [Automate what happens to a ticket](docs/guides/automate-tickets-with-workflows.md).

### Onboarding: the checklist describes the workspace, it is not a to-do list

`/onboarding` is where a new tenant admin lands after signup and returns to afterwards
(TAR-36). It walks them through connecting a WhatsApp number, inviting agents and setting
branding, and it is gated on `tenant:settings` — the permission its own endpoints require.

Three things about it are decided by the contract rather than by taste:

- **Completion is server-derived; only skipping belongs to the client.** A step is `completed`
  because the tenant actually has a connected WABA or has sent an invitation — never because
  somebody ticked a box. That is why `PATCH /v1/tenant/onboarding/steps/{stepId}` takes an
  _intent_ (`skip` / `reopen`) and not a status: a client that could write `completed` would
  let an admin mark a workspace set up that has no number attached to it, and the checklist
  would then be decoration rather than a description of the workspace. The mock transport
  keeps the same rule — `handlers.ts` flips a step from the handler that does the real thing.
- **Skipping is not finishing, and it is reversible.** `skipped` is its own state, so a step
  put off stays returnable — that is TAR-36's requirement, and it is why the completion notice
  renders _above_ the list rather than replacing it. The progress meter fills on
  completed + skipped, because a bar that can never reach the end reads as an outstanding task
  rather than as a decision the admin already made.
- **Which step is open lives in the URL.** `?step=` is read through `parseOnboardingStep`, and
  absent means "the first step still pending". That keeps the whole walkthrough a server
  component — the only client island is the skip button — and makes "carry on where I left
  off" a link somebody can share and the back button can undo.

**Where the contract stops.**
[ADR 0009](docs/architecture/0009-tenant-lifecycle-and-self-signup.md) owns the tenant
lifecycle, signup, provisioning, retention and the notification hooks, and lists "the
onboarding checklist's own state" among its non-goals — TAR-407 owns the checklist, its steps
and its persistence, and 0009 defines only the lifecycle state the checklist runs inside. So
`packages/contracts/src/onboarding.ts` is the checklist's contract and nothing more: it reuses
`tenant.ts`'s lifecycle vocabulary and adds nothing to it. Its two routes sit alongside 0009's
tenant surface (`/v1/tenant/lifecycle`, `/v1/tenant/cancel`) and share the `tenant:settings`
permission that document assigns to a tenant-settings read.

`set_branding` links nowhere: TAR-29 owns the branding editor and it does not exist yet, so the
step says so and offers the skip rather than pointing at a route that would 404.
`features/onboarding/presentation.ts` is the one place that mapping lives.

### Route groups: signed in and signed out

`app/` holds two route groups, and neither changes a URL — `/inbox` is still `/inbox`.

| Group        | Layout renders                                                  | Session              |
| ------------ | --------------------------------------------------------------- | -------------------- |
| `app/(app)`  | Skip link, then `AppShell` — the rail, the top bar and `<main>` | Required — see below |
| `app/(auth)` | A centred card column with the wordmark and `<main>`            | None at all          |

The split exists because password recovery is reachable by somebody who cannot sign in. A
root layout that resolved the principal would answer 401 to a visitor following a reset
link out of their inbox, so the root layout does the document, the theme and the toast
system, and each group brings its own shell. `features/auth/components/AuthCard` is the
frame every signed-out screen sits in; login and invite-accept (TAR-60) drop into it
unchanged.

The reset link is `/reset-password#token=…` — the token travels in the **fragment**, which
browsers never send to a server, so it stays out of access logs, proxies and `Referer`
headers. The price is that the reset screen must be client-rendered and must scrub the
fragment once it has read it (`features/auth/useResetToken.ts`). The path is fixed by the
API's `RESET_PASSWORD_LINK_PATH`; `lib/routes.test.ts` pins the two together.

### Route guards and sessions

The console never decides who the caller is. Tenant, role and permissions come from
`GET /api/v1/auth/session`, resolved by the API from the httpOnly session cookie — nothing
is inferred from the cookie's presence, nothing is cached in the browser, and no
client-supplied tenant or role is ever consulted.

The guard has two halves, and only the second one is a gate:

| Half              | Where                    | Asks                          | Costs                     |
| ----------------- | ------------------------ | ----------------------------- | ------------------------- |
| **Optimistic**    | `proxy.ts`               | Is there a session cookie?    | Nothing — no API call     |
| **Authoritative** | `lib/session/session.ts` | Who does the API say this is? | One round-trip per render |

`proxy.ts` — Next 16's rename of `middleware.ts` — runs on every request, including
prefetches, so it only looks for the cookie. Presence proves nothing about validity, which
is why the answer that matters comes from `verifySession()`. What the first half buys is
the common case: a signed-out visitor opening a deep link gets a redirect instead of a
render that fetches, fails and redirects anyway.

Either half sends the caller to `routes.login({ redirectTo })`, so `?next=` carries the
page they were denied and sign-in returns them to it. That value is attacker-controlled and
is narrowed by `parseRedirectPath` on the way out — an absolute, protocol-relative or
backslash-prefixed value is dropped, never corrected, because following one hands a
freshly authenticated user to somebody else's site.

**The check lives next to the data, not in the layout.** A layout does not re-render on
client navigation and does not decide whether the segments below it render, so
`lib/api/authenticated.ts` is the transport every authenticated call goes through: it
verifies the session, forwards the caller's cookie (server rendering is not the browser, so
`credentials: 'include'` does nothing there), and turns a lost session into a sign-in.
`getSession()` is wrapped in React's `cache`, so this costs one session call per render
pass, not one per query. Unauthenticated endpoints — password-reset request and confirm —
stay on `apiRequest` directly, because a caller who has lost their password has no session
to forward.

Three answers, three outcomes:

| API says                                       | Console does                                              |
| ---------------------------------------------- | --------------------------------------------------------- |
| 401 `unauthenticated` — expired, revoked, gone | Redirect to sign-in, keeping `?next=`                     |
| 401 `tenant_mismatch` — replayed cross-tenant  | The same: sign in on the host you belong to               |
| 403 `forbidden` — signed in, lacks the right   | The explanatory forbidden state, **not** a sign-in bounce |

The 403 row is deliberate: bouncing that caller to sign in would tell them to fix the one
thing that is not wrong. Anything else — a 502, an unreachable API — is rethrown as an
error the user can retry, because redirecting on it would sign everybody out whenever the
API restarted, with no way for them to tell why.

Nothing is cached across requests, so an admin deactivating an agent, a password reset
revoking every session, or a sign-out shows up on that agent's **very next request** rather
than whenever a copy expires. `signOutAction` is the same story from the other side: it
revokes server-side first, then clears the browser's cookie, because the API's
`Set-Cookie` comes back to the Next process and not to the person leaving.

⚠️ A server action is a POST to the route it lives on, so `proxy.ts` covers it — but a
matcher is never the gate. Every action still asserts for itself, and the two that map every
failure onto an inline message call `unstable_rethrow` first, so the guard's `redirect` is
not swallowed as though it were a failed request.

### Permissions in the UI

The UI asks _"may this principal do X"_, never _"is this principal an admin"_ — the same rule
TAR-39 fixed for the API guards. `lib/session/permissions.ts` builds a checker from the
principal's permissions, which `ROLE_PERMISSIONS` in `packages/contracts/src/rbac.ts`
materialises from the role. Navigation entries declare `requiresAny` in
`components/shell/navigation.ts` and are filtered once, on the server.

A navigation entry may omit `requiresAny` entirely, which means _every signed-in
principal_ — not the same as an empty array, which would hide it from everyone. It is for
a surface whose subject is the caller rather than the tenant: `/settings/security` is
gated by no permission, because a role that cannot change its own password is a role that
cannot recover from a leaked one.

**None of this is a security boundary.** A server action asserts the permission again, and
the API asserts it a third time. The UI gating exists so a role is never shown a control
that leads to a refusal.

### Workspace settings: two surfaces behind two gates

`/settings/workspace` (TAR-409) is the tenant admin's view of its own workspace: the
profile, the branding currently in effect, and the plan with its seat and conversation
usage. It is the one settings page whose nav entry names **two** permissions, because it is
genuinely two surfaces:

| Half                            | Endpoint                       | Permission        |
| ------------------------------- | ------------------------------ | ----------------- |
| Profile (name, support address) | `PATCH /api/v1/tenant`         | `branding:write`  |
| Plan, usage, lifecycle banner   | `GET /api/v1/tenant/lifecycle` | `tenant:settings` |

Both are admin-only under today's `ROLE_PERMISSIONS`, so nobody currently sees half of it.
The split exists so a custom role holding one of them gets the half it may have rather than
a 403 for the whole page: `WorkspaceSections` renders the profile read-only without
`branding:write`, and omits the plan card entirely without `tenant:settings`.

**The word is _workspace_.** `docs/STYLE.md` fixes _tenant_ as the internal term and
_workspace_ as the only one the console says on screen; _organisation_ is on the
forbidden-synonym list. The route, the content group and the feature folder all take the
on-screen word even though the issue that asked for it said "organization profile".

`TenantLifecycleResponse` is what the plan panel renders, and it is deliberately not
`BillingSummaryResponse` — that one describes a subscription, and a workspace on a trial has
none. Pending invitations count towards the seat cap alongside active agents, because ADR
0009 enforces the cap at invite creation as well as acceptance; `lib/plan/usage-reading.ts`
owns that arithmetic — `features/workspace/plan-usage.ts` and `features/billing` both read
through it — so a second surface cannot re-derive it differently.

Two primitives came out of this page and are reusable: `components/ui/DetailList` (term and
value pairs as a real `<dl>`, two columns above a container-query threshold) and
`components/ui/UsageMeter` (an allowance gauge whose bar is `aria-hidden` decoration over a
sentence that states the numbers).

### Plans and billing: the redirect is not the confirmation

`/settings/billing` (TAR-37) is where a tenant admin compares plans, starts a checkout and
reaches the payment provider's own customer portal. Same two-gate shape as Workspace above:
`billing:read` reaches the plans and the meters, `billing:manage` is what starts a checkout
or opens the portal, and the nav entry names both.

**Nothing in `apps/web` names the payment provider.** The console asks for a plan list, a
checkout session and a portal session; which rail answers is decided behind
`BillingProvider` in `apps/api/src/billing/providers/`, and every provider identifier that
reaches this tier is an opaque string inside a URL. That is what let this surface be built
and reviewed before any of it existed.

Five routes, exactly as the contract publishes them, all through `lib/api/billing.ts`:

| Route                              | Permission       | Notes                             |
| ---------------------------------- | ---------------- | --------------------------------- |
| `GET /api/v1/billing/plans`        | `billing:read`   | tiers plus this tenant's position |
| `GET /api/v1/billing/subscription` | `billing:read`   | current plan, dates, usage        |
| `GET /api/v1/billing/usage`        | `billing:read`   | counters against their ceilings   |
| `POST /api/v1/billing/checkout`    | `billing:manage` | requires an `Idempotency-Key`     |
| `POST /api/v1/billing/portal`      | `billing:manage` | short-lived; minted on the click  |

Four rules are worth knowing before you touch this page:

1. **The redirect back from a hosted checkout is not evidence of anything.** It routinely
   beats the provider's own subscription webhook, so `reportCheckout` has **three**
   outcomes, not two: `succeeded` only when the subscription is active _and_ on the plan the
   checkout was for, `cancelled`, and `confirming` for the gap in between. The page never
   congratulates somebody on a plan change the API cannot see. The plan rides in the URL
   (`?checkout=succeeded&plan=growth`) precisely so an upgrade between two paid tiers cannot
   be mistaken for the tier the tenant was already on.
2. **Whether a plan can be chosen is the API's answer, never the console's.** `isSelectable`
   and `blockedBy` depend on live usage the console does not hold. A card whose ceilings sit
   below current usage says _which_ ceiling blocks it, in words — a control that silently
   will not press is not an explanation.
3. **The seat cap is rendered from the refusal, not from a count.** `InviteAgentDialog`
   shows its upgrade path only after the invite endpoint answers `plan_limit_exceeded`; it
   never pre-checks. A dialog that disabled its own submit from a stale count would refuse
   invitations the API would have allowed. That is what `ActionResult.code` and
   `useActionForm`'s `errorCode` exist for — branch on the code, never on the message, which
   is server-owned copy.
4. **A requested cancellation is not a closed workspace.** The provider reports one the
   moment it is asked for and the tenant has paid through the period, so `cancelsAt` drives a
   "closing on…" banner and no lifecycle transition at all.

Cancellation, plan changes, invoices and the payment method all live in the provider's
portal rather than here: it owns the confirmation, the effective date and the receipt, and
two places that can end a subscription is one too many.

One primitive came out of this page and is reusable: `components/ui/AlertBanner` — a
page-level `role="status"` message with a heading, a body and a slot for the way out of it.
`Notice` stays the right choice for a single sentence inside a card.

In mock mode the fixture transport stands in for the hosted pages as well as for the API: it
applies the subscription immediately and hands back the console's own return URL on
`http://localhost:3000`, so the whole loop is walkable with no provider account. Against a
real provider the redirect races the webhook, which is why the `confirming` branch exists
and is covered by unit test rather than by clicking.

### The chatbot: silence is a state the console has to explain

`/settings/chatbot` (TAR-28) is where a tenant admin writes the knowledge base the AI
chatbot answers from and decides when it answers at all. Everything on it follows from one
rule in
[ADR 0010](docs/architecture/0010-ai-chatbot-knowledge-base-and-handoff.md): **the
empty-knowledge-base guarantee is structural, not behavioural.** With nothing indexed, no
prompt is assembled and no request is made, so a hallucinated answer is impossible — and the
product's visible behaviour is that the chatbot says nothing at all.

Silence and a broken feature look identical, which is why `GET /api/v1/ai/config` publishes
a `readiness` breakdown rather than a bare toggle, and why `BotReadinessPanel` is the first
thing on the page. It lists **every** failing clause, not the first: an admin who clears one
of four and still gets silence has learned nothing. `aiReadiness` in the mock transport
derives the answer from the plan and the stored documents on every read for the same reason —
a cached `ready: true` would be the console claiming replies that cannot happen.

The knowledge base is written, not uploaded. A blank line is a chunk boundary — the indexer
packs paragraphs — so the entry dialog says so where somebody is typing, and nothing else in
the product ever would. A write is asynchronous in exactly one respect: `POST`, and a `PATCH`
that changes the text, come back `pending` and the chatbot cannot use the entry until
indexing commits. The table renders that state rather than hiding it, and a `failed` entry
carries its `indexError` on the row, because the chatbot ignores a failed entry silently.

In the inbox, `conversation.botState` replaces `botHandling` as what the badge reads.
The boolean is still published and still means `botState === 'bot_active'`; what it cannot
say is the difference between a conversation the chatbot never touched and one it **gave up
on**, and only the second needs somebody now. `messages.origin` does the same job one level
down: a workflow reply (TAR-27) is also "sent automatically", so `origin === 'bot'` is what
lets the thread name the chatbot rather than automation in general.

`GET /api/v1/conversations/{id}/handoff` is deliberately **not** a transcript. A bot reply is
an ordinary `messages` row — it was genuinely sent to the customer — so the thread already
holds the exchange, and `HandoffPanel` renders only what the transcript cannot carry: why the
chatbot stopped, the composite confidence with both halves it is the `min` of, and the
knowledge base entries it cited. That last field is the one that earns its place: it is how
an agent spots that the chatbot answered from the refunds policy when the customer asked
about shipping.

| Surface                    | Endpoint                                  | Permission           |
| -------------------------- | ----------------------------------------- | -------------------- |
| Readiness, settings (read) | `GET /api/v1/ai/config`                   | `ai:read`            |
| Settings (write)           | `PATCH /api/v1/ai/config`                 | `ai:write` + plan    |
| Knowledge base             | `/api/v1/knowledge-documents`             | `ai:read`/`ai:write` |
| Handoff summary            | `GET /api/v1/conversations/{id}/handoff`  | `conversation:read`  |
| Take a thread from the bot | `POST /api/v1/conversations/{id}/handoff` | `conversation:claim` |

`GET /ai/config` is readable **without** the `ai_chatbot` plan feature, so the page can render
an upsell instead of a 403; the `PATCH` is refused. The handoff pair is `conversation:*`
rather than `ai:*` on purpose — `ai:read` is admin-only, and the agent reading the summary is
exactly who it is for.

The backend (TAR-406) and the schema (TAR-402) landed as separate stories and are both on
`main`, so the API now publishes a real `botState` and a real `origin`. The console still
reaches them through the mock transport wherever `NEXT_PUBLIC_USE_MOCK_API` is on — see
[Interim state](#interim-state-mock-api-and-stubbed-role), which is not specific to this
surface.

The full endpoint surface, the confidence rules and the handoff reasons are in
[the AI chatbot and knowledge base API reference](docs/reference/chatbot-api.md); the console
side is documented for its two readers in
[Set up the chatbot and its knowledge base](docs/guides/set-up-the-chatbot.md) and
[Work with the chatbot in the inbox](docs/guides/work-with-the-chatbot-in-the-inbox.md).

### Interim state: mock API and stubbed role

Two flags in `.env.example` exist because TAR-82 was built ahead of its dependencies. Real
sessions have since landed on both sides — signing in, the API's session cookie and the
console's route guard all work, and with the stub off the API answers `401` to anything that
is not a real session. The flags survive as a development and test convenience only. Both
default to off in code (`lib/config/env.ts`) and both must stay off in a deployed
environment; `.env.example` turns both on, and its comments say why:

- `NEXT_PUBLIC_USE_MOCK_API` serves every API call from `lib/api/mock/` instead of HTTP.
  The mock is a _transport_, not a per-feature fake: the resource modules in `lib/api/` are
  identical in both modes, so wiring the real endpoints is one flag. The mock enforces the
  same tenant scoping and permissions the real API does, and seeds a second tenant purely so
  that isolation is testable.
- `NEXT_PUBLIC_ENABLE_ROLE_STUB` reads the role from a cookie and exposes a switcher, so the
  agent/supervisor/admin views can be demonstrated without three real accounts.
  `getSession()` refuses it in production regardless of the flag, and while it is on the
  route guard stands down — there is no session cookie to look for, and no sign-out button
  offered, because there would be nothing to end. Its API half is `AUTH_STUB_ENABLED`,
  which binds `StubPrincipalSource` in place of the session reader and is refused under
  `NODE_ENV=production`; the two are driven by the same `wac_role_stub` cookie so they
  cannot disagree. The browser reaches the API through the rewrite and carries that cookie
  itself; server rendering and server actions do not, so the transport translates it to the
  API's `x-dev-role` header on every server-side call (`lib/session/role-stub-request.ts`).
  Without that the switcher moved the chrome and nothing else, and every call resolved as
  the tenant's default admin (TAR-366). The API half also upserts a live `sessions` row for
  the user it resolves and names it on the principal, because the realtime handshake re-reads
  the session behind a ticket rather than trusting it — without a row, every WebSocket upgrade
  was refused and no live update arrived (TAR-576). What the stub replaces is the source of the
  principal, never a guard — see
  [Driving this surface locally](docs/reference/people-api.md#driving-this-surface-locally).

## License

MIT — see [LICENSE](LICENSE).
