# WhatsApp CRM

Multi-tenant, white-label WhatsApp CRM and helpdesk platform, built on the official
WhatsApp Business Cloud API.

> **Status: early.** This repository contains the project skeleton, the stack decision, the
> local development harness, the database schema, its tenant isolation and the two Prisma
> clients that enforce it, and the first product path end to end — inbound WhatsApp
> webhooks. Feature work is tracked as the TAR-18 epic. The database has **tables but
> almost no rows**: the data model landed with TAR-47, row-level security with TAR-48, the
> client split with TAR-49, webhook ingestion with TAR-20, and seed data arrives with
> TAR-46. Everything below works today.

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
ingestion pipeline, which is the first thing that needed a queue; Socket.IO is decided but
not yet installed and arrives with the realtime gateway.

## Layout

| Path                       | What it is                                                    |
| -------------------------- | ------------------------------------------------------------- |
| `apps/api`                 | NestJS HTTP API                                               |
| `apps/api/src/prisma`      | The `TenantPrisma` / `SystemPrisma` clients and RLS wiring    |
| `apps/api/src/queue`       | BullMQ registration and tenant context propagation into jobs  |
| `apps/api/src/webhooks`    | WhatsApp webhook ingest, its worker and the stuck-event sweep |
| `apps/api/prisma`          | Database schema and migrations                                |
| `apps/api/prisma/sql`      | Operational SQL that is not a migration — roles, RLS check    |
| `apps/web`                 | Next.js agent console                                         |
| `packages/contracts`       | Zod schemas and types shared by both apps — the API contract  |
| `packages/tsconfig`        | Shared TypeScript configuration                               |
| `docker-compose.yml`       | Local PostgreSQL and Redis                                    |
| `docker/postgres/initdb.d` | First-boot SQL for the local Postgres container               |
| `docs/adr`                 | Architecture decision records                                 |

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
pnpm dev                     # 7. run the API and the frontend
```

That is the whole setup. Step 3 blocks until both containers report healthy, so step 4
never races the database. Step 5 has to come after step 4 — it grants privileges on the
tables step 4 creates — and is idempotent, so re-running it is always safe.

Step 6 exists because `db:roles` deliberately creates both roles `NOLOGIN` and without a
password: a password belongs in an environment's secret store, not in a file in this
repository, and the same file runs in staging. `db:roles:login` is that operator step,
scripted, with the throwaway value `.env.example` already uses. Skip it and the API boots
but every query fails to authenticate.

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
# Tests: 68 passed — the same guarantee through TenantPrisma, plus provisioning
#                   and the WhatsApp webhook ingestion pipeline
```

The `checks` object is empty on purpose: the endpoint reports process liveness only and
must never claim dependency health it has not measured. Real database and queue probes
arrive with TAR-41.

**The database has tables but no rows — that is the expected state.** Seeding is TAR-46.
Provision a tenant to get one (see [Provisioning a tenant](#provisioning-a-tenant)). To see
what step 4 built:

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
| `pnpm db:studio`         | Opens Prisma Studio against the local database                        |
| `pnpm db:generate`       | Regenerates the Prisma client from `schema.prisma`                    |
| `pnpm db:roles`          | Creates the application roles and their grants — run after migrations |
| `pnpm db:roles:login`    | Gives those roles the throwaway local password                        |
| `pnpm db:roles:down`     | Removes those roles                                                   |
| `pnpm db:verify:rls`     | Proves two tenants cannot see each other's rows                       |

The last four run `psql` inside the Postgres container against
`apps/api/prisma/sql`, which `docker-compose.yml` mounts at `/sql`. They assume the
default `whatsappcrm` user and database; if you changed either in `.env`, run `psql`
directly instead.

`pnpm db:down` leaves your data in place. To throw it away as well —
`docker compose down -v`, which deletes the volumes and, on the next `pnpm db:up`,
re-runs the first-boot SQL in `docker/postgres/initdb.d`.

**`pnpm db:reset` has two guards, and both are deliberate.** In a non-interactive shell
it refuses to run and tells you to pass `--force`. And Prisma 7 detects AI coding agents
and blocks destructive commands outright unless `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`
is set to the text of the message in which you consented. Neither guard affects a human at
an interactive prompt; both will stop an agent, which matters for TAR-46's seed script and
for any automated task that expects to reset the database unattended. The route back to a
known-good state that passes both guards is
`docker compose down -v && pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login`
— equally destructive, but it never invokes `migrate reset`. The two role steps are not
optional: `down -v` destroys the volume, and the roles live in the cluster it took with it.

## Working with the database

Postgres 17 and Redis 7 run from `docker-compose.yml`. Two details in there are
deliberate and worth knowing:

- Redis runs with `maxmemory-policy noeviction`, which **BullMQ requires** — under memory
  pressure any other policy lets Redis silently discard job data.
- Postgres logs any statement slower than 500 ms. `pnpm db:logs` is the fastest way to
  catch a bad plan before it reaches staging.

Connection details come from `.env` and are the same values Compose itself reads. The
password there is a throwaway for a container bound to localhost; it is not a secret and
must not be reused anywhere.

### The data model

`apps/api/prisma/schema.prisma` is the single source of truth for the database shape. It
expresses the entity table in `docs/architecture/0002-architecture-and-api-contract.md`
(TAR-39) — read that first for _why_ the entities are shaped this way; the schema file
carries the per-model reasoning next to each model.

Six conventions hold across every model, and a change that breaks one needs a reason:

1. **Every tenant-scoped table carries a non-null `tenant_id`**, even where the tenant is
   already reachable through a foreign key. An RLS policy is a row predicate and cannot
   join. Exactly three tables do not have one, all deliberately: `tenants`, `plans`
   (platform-wide product data) and `webhook_events` (written before the tenant is known,
   so its `tenant_id` is nullable and it is never RLS-protected).
2. **Tenant-scoped foreign keys are composite** — `(tenant_id, <parent_id>)` referencing
   the parent's `UNIQUE (tenant_id, id)`, never the parent's `id` alone. RLS stops a
   tenant _reading_ another tenant's row; this is what stops one being _referenced_ by a
   handler that took an id from a request body.
3. **Composite indexes lead with `tenant_id`**, and sort keys are
   `(<timestamp> DESC, id DESC)` so keyset pagination has a total order.
4. **Referential actions are only ever `Cascade` or `NoAction`** — never `Restrict` (it is
   checked immediately and would abort a legitimate cascading tenant delete) and never
   `SetNull` (on a composite key it would null `tenant_id`, which is `NOT NULL`).
5. **Ids are UUIDv7**, generated by the Prisma client. Postgres 17 has no native
   `uuidv7()`, so there is no column default — anything inserting outside the client must
   supply the id.
6. **Timestamps are `timestamptz`**, money is integer minor units plus an ISO 4217 code,
   phone numbers are E.164, and emails/slugs/hostnames are `citext`.

### Tenant isolation

Isolation is enforced by the database, not by application code remembering a `where`
clause. All 34 tenant-scoped tables have `FORCE ROW LEVEL SECURITY` and one policy:

```sql
CREATE POLICY tenant_isolation ON conversations
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

`app.tenant_id` is a per-transaction setting the Prisma client extension sets before each
query (TAR-49). Three properties fall out, and all three are what make this worth having:

- **A connection that has not set it sees nothing.** Not "everything" — nothing. Both the
  never-set case (`current_setting` returns NULL) and the cleared case (it returns the
  empty string, which is why the `NULLIF` is there) fail closed.
- **`FORCE` includes the table owner.** Without it, migrations — and anything else
  connecting as the owner — would be exempt, which is the opposite of what you want.
- **Writes are checked too.** `WITH CHECK` means a handler that takes a `tenant_id` from a
  request body cannot write into another tenant; the insert is rejected outright.

Three tables deliberately carry no policy: `tenants` (it _is_ the tenant, and provisioning
reads it before one is in scope), `plans` (the shared product catalogue) and
`webhook_events` (written before the tenant is known — TAR-39's documented exception).

Two roles back this up, created by `apps/api/prisma/sql/app-roles.sql`:

| Role                 | Holds                                                | Sees                                           |
| -------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| `whatsappcrm_app`    | No `SUPERUSER`, no `BYPASSRLS`. DML on scoped tables | Only the tenant in `app.tenant_id`             |
| `whatsappcrm_system` | The same, plus a `system_unrestricted` policy        | Everything — the five `SystemPrisma` uses only |

`SUPERUSER` and `BYPASSRLS` skip policy evaluation entirely, so the app role must hold
neither; `pnpm db:verify:rls` fails if it ever does. Both roles are created `NOLOGIN` —
granting login means handing out a password, which comes from the environment's secret
store, never from this repository:

```sql
ALTER ROLE whatsappcrm_app LOGIN PASSWORD '<value from the secret store>';
```

**`pnpm db:verify:rls` is the proof, not the documentation.** It creates two tenants,
reconnects so the connection has genuinely never set the GUC, and asserts that all 34
tables return zero rows; that each tenant then sees its own rows and none of the other's;
that a cross-tenant insert is rejected and a cross-tenant update or delete matches
nothing. It exits non-zero on the first failure and cleans up after itself. CI runs it on
every pull request. It writes to the database it is pointed at, so point it at a local or
disposable one.

**RLS carries the guarantee; it does not always carry the plan.** Measured by TAR-48 on
50k conversations across 20 tenants, the inbox query drops from an index-only scan reading
50 rows to a bitmap scan of the whole tenant plus a top-N sort. The cause is that
`enum_eq` is not leakproof, so under RLS a `status = 'open'` qual cannot be pushed into
the index condition. It does not matter at this size and it will at a large tenant's. Two
things restore the plan when it does: a partial index, or an explicit `tenantId` in the
query's own `where`. The client does **not** inject that automatically — see the caveat at
the end of the next section.

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
away from being set, invisible at the injection site, and impossible to review by search;
a token appears in the constructor of every class allowed to use it. TAR-39 permits five
such classes — provisioning, login before a tenant is known, webhook ingest, the sweeper,
and platform reporting — and a sixth needs a justification in review.

`TenantPrisma` sets the GUC by wrapping every statement in a transaction:

```sql
BEGIN;
SELECT set_config('app.tenant_id', assert_tenant_active($1), true);  -- true = transaction-local
<the query>;
COMMIT;
```

The tenant comes from `TenantContextService`'s `AsyncLocalStorage`, which HTTP requests,
queue jobs and WebSocket handlers all share. **No tenant in scope throws**, before
anything is sent — the query never happens, rather than happening and returning nothing.
That distinction is the whole point: zero rows is indistinguishable from an empty table,
so a code path that forgot to resolve its tenant would look like a working one.

`assert_tenant_active` is the deactivation gate (TAR-51, below). It returns the id when
that tenant is `active` and raises `TenantNotActiveError` otherwise, and Postgres evaluates
it before `set_config` — so a deactivated tenant never sets the GUC, and the statement
batched behind it never runs.

Three things to know before writing a query against it:

- **It costs three extra round trips.** Measured against the local Compose stack:
  0.7 ms for a plain query, 2.3–3.4 ms for a scoped one. Prisma 7's driver-adapter client
  sends `BEGIN`, `set_config`, the query and `COMMIT` as four separate messages, not one
  batched round trip. For anything issuing several statements, use
  `prisma.$tenantTransaction(async (tx) => …)`: it opens one transaction, sets the GUC
  once, and pays that cost a single time instead of per query. The status check adds no
  round trip of its own — it is a primary-key lookup inside the `set_config` statement
  that was already being sent.
- **Batch `$transaction([…])` does not work on it.** The extension hook is async, so the
  client returns ordinary promises rather than the `PrismaPromise`s a batch needs. Use
  `$tenantTransaction`.
- **`tenants`, `plans` and `webhook_events` have no RLS policy**, so the client applies
  one itself: `Tenant` reads are narrowed to the tenant in scope and its writes refused,
  `Plan` is read-only, and `WebhookEvent` is refused outright. Inside
  `$tenantTransaction` the client handed to your callback is the un-extended one, so
  those three rules do not apply there — RLS still covers everything else.

**Not built here, and deliberately:** the extension does not inject `tenantId` into
`where`/`data` for the 33 scoped models. RLS already filters them correctly, and a
generic injection has to get nested writes, `connect`, `upsert` and relation filters right
or it silently drops rows — worse than not having it. Where a plan needs the explicit
predicate (see the measurement above), pass `tenantId` in the query's own `where`.

### Provisioning a tenant

Tenants are admin-provisioned; there is no self-signup. Provisioning is one call, and it
writes the tenant, its settings and its platform subdomain in a single transaction:

```bash
curl -X POST http://localhost:3001/api/v1/admin/tenants \
  -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"acme","name":"Acme Ltd","timezone":"Europe/London","locale":"en-GB"}'

# 201 Created
# {"id":"019f…","slug":"acme","name":"Acme Ltd","status":"active",
#  "primaryHostname":"acme.app.localhost",
#  "settings":{"timezone":"Europe/London","locale":"en-GB"},"createdAt":"…"}
```

Things worth knowing before you call it:

- **`201` means provisioned, `200` means it already existed.** The call is idempotent on
  `slug`, so re-running a provisioning script is safe. A repeat never renames the tenant,
  never changes its status and never resets its settings — those are `PATCH /tenant` and
  TAR-36's lifecycle, not a side effect of replaying a script. It does add a settings row
  or a platform domain that is missing.
- **The hostname is derived from the slug**, `<slug>.$PLATFORM_DOMAIN`, and is never taken
  from the request. If another tenant already holds that host, the whole call is refused
  with `409 conflict` and nothing is written — there is no half-provisioned tenant to
  clean up.
- **It authenticates with `PLATFORM_ADMIN_TOKEN`, not a session.** The platform operator
  is not a user inside any tenant, and provisioning has to work before the first user
  exists. Leave the variable unset and the whole admin surface refuses every request.
  This is a placeholder for a real platform-admin identity, which arrives with TAR-35's
  and TAR-22's work.
- **A provisioned tenant has no users yet.** Inviting the first one is TAR-35.

The route runs on `SystemPrisma` — the only client that can write `tenants` — and is one
of the five call sites TAR-39 permits for it.

### Deactivating a tenant

Deactivation takes a tenant's access away and keeps its data. One call, and it is in force
the moment it commits:

```bash
curl -X POST http://localhost:3001/api/v1/admin/tenants/acme/deactivate \
  -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Non-payment, ticket OPS-412"}'

# 200 OK
# {"id":"019f…","slug":"acme","name":"Acme Ltd","status":"suspended",
#  "suspendedAt":"…"}
```

Things worth knowing before you call it:

- **It is not a delete, and there is no data loss to undo.** Two columns are written —
  `tenants.status` and `tenants.suspended_at` — and nothing else. Every contact,
  conversation, ticket and message stays where it was and stays reachable through
  `SystemPrisma` for support, billing and export.
- **The block is in the database, not in a guard.** `assert_tenant_active` is called by
  every `TenantPrisma` statement (see "The two Prisma clients" above), so the tenant's
  agents stop reaching their data on their very next query — through open sessions,
  in-flight background jobs, WebSocket handlers and raw SQL alike. There is no cache to
  expire, and no new route can forget to apply it.
- **No other tenant is affected.** One row is written and the gate reads only the row the
  GUC names. `apps/api/src/tenancy/tenant-deactivation.int-spec.ts` is the regression
  proof: it deactivates one tenant and asserts its neighbour still reads, writes and runs
  transactions normally.
- **It is idempotent.** A repeat call answers `200` and changes nothing — including
  `suspendedAt`, which records when access was actually revoked and must survive a
  replayed script. A slug no tenant carries answers `404`, so a typo during an incident is
  visible rather than silently successful.
- **Reactivation is not here.** `suspended → active` belongs to TAR-36's lifecycle state
  machine; an endpoint that exists to take access away should not also be the one that
  gives it back. Until it ships, an operator restores a tenant by setting `status` back to
  `active` through the platform's own database access.
- **A `pending` or `cancelled` tenant is blocked by the same gate.** Only `active` reaches
  data, so a half-provisioned tenant is closed by the mechanism rather than by a second
  rule.

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

To apply one against the local database:

```bash
docker compose exec -T postgres psql -U whatsappcrm -d whatsappcrm \
  < apps/api/prisma/migrations/<timestamp>_<name>/down.sql
```

Prisma does not know you did this, so delete the corresponding row from
`_prisma_migrations` afterwards or `migrate status` will keep reporting the migration as
applied. Locally, `pnpm db:reset` is usually the faster path.

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

A repeatable sweep re-enqueues anything still `received`, or stuck in `processing`, past
`WEBHOOK_STUCK_AFTER_MS`. That job is what converts a Redis outage into message
_lateness_ rather than message _loss_, so an inbox that has stopped updating usually needs
Redis looked at rather than anything replayed by hand. `webhook_events` in `received`
older than five minutes is the condition worth alerting on.

Without `REDIS_URL` the API still boots and still accepts and stores deliveries — it logs
a warning at startup and nothing processes them until a worker exists.

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

`main` is protected, and **Lint**, **Type-check** and **Test** are **required** — they
gate the merge rather than merely reporting on it. **Database** is not yet in that list;
adding it is a change to the repository's protection rule, not to the workflow file. The
branch must also be up to date with `main` before merging, review threads must be
resolved, administrators are included, and force pushes and branch deletion are blocked.

In practice that means every change lands through a pull request: a direct push to `main`
is rejected with `GH006: Protected branch update failed`, because the commit being pushed
carries no passing checks. Renaming a job in the workflow renames its required check and
silently removes the gate, so update the protection rule in the same change.

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
required.

`PLATFORM_ADMIN_TOKEN` is optional in a different sense: leaving it unset does not disable
validation, it disables the whole platform admin surface. Every request to
`/api/v1/admin/*` is refused, which is the safe default for routes that create tenants.
Generate one with `openssl rand -base64 48` and keep it in the secret store.

`WHATSAPP_APP_SECRET` and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` are optional in exactly the same
sense, and for a sharper reason: the webhook route is public and unauthenticated, so an
environment with no app secret must refuse every delivery rather than accept unsigned
ones. Both are platform-level and come from the Meta app dashboard — one Meta app serves
every tenant, and tenant routing is `phone_number_id` → `whatsapp_accounts`, never a
per-tenant secret.

The Prisma CLI reads its own configuration from `apps/api/prisma.config.mjs`, which loads
the repository-root `.env`. Prisma 7 does not load `.env` on its own and no longer accepts
`url = env(...)` inside the schema, so that file is the single place the CLI learns where
the database is. A variable already set in the real environment wins over the file, which
is what makes `DATABASE_URL=… pnpm db:migrate:deploy` work against any target.

## Conventions worth knowing before you write code

- **Tenant scoping goes through `TenantContextService`**
  (`apps/api/src/common/tenant-context/`). It is an `AsyncLocalStorage` scope that works
  in HTTP requests, queue workers and WebSocket handlers alike. Do not build a second
  mechanism. Use `requireTenantId()` wherever a missing tenant is a bug — it throws
  rather than letting an unscoped query run.
- **Shared types live in `packages/contracts`.** If the API and the frontend both need to
  know a shape, it is a Zod schema there, not a duplicated interface.
- **Errors have one envelope** (`ApiErrorSchema`), and the frontend has one error type
  (`ApiRequestError` in `apps/web/lib/api.ts`). Every response carries `x-request-id`,
  which ties a user-reported error to a log line.

## License

MIT — see [LICENSE](LICENSE).
