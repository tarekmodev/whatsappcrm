# WhatsApp CRM

Multi-tenant, white-label WhatsApp CRM and helpdesk platform, built on the official
WhatsApp Business Cloud API.

> **Status: scaffold.** This repository currently contains the project skeleton, the stack
> decision, the local development harness, the database schema and its tenant isolation —
> no product features. Feature work is tracked as the TAR-18 epic. The database has
> **tables but no rows**: the data model landed with TAR-47, row-level security with
> TAR-48, and seed data arrives with TAR-46. Everything below works today.

## Stack

TypeScript on Node 22 · NestJS 11 API · Next.js 16 frontend · PostgreSQL · Prisma ·
Socket.IO · BullMQ on Redis · deployed to Render.

Every one of those choices, the alternatives weighed against it, and the failure modes
they imply are recorded in **[`docs/adr/0001-stack-decision.md`](docs/adr/0001-stack-decision.md)**.
Read that before proposing a change to any of them.

Prisma is installed as a **CLI only** — schema and migrations, no generated client and no
`@prisma/client` dependency. Prisma 7 clients need a driver adapter, which is a decision
for the story that writes the first query (TAR-49) rather than one to inherit. Socket.IO and BullMQ
are decided but not yet installed; each arrives with the story that first needs it.

## Layout

| Path                       | What it is                                                   |
| -------------------------- | ------------------------------------------------------------ |
| `apps/api`                 | NestJS HTTP API                                              |
| `apps/api/prisma`          | Database schema and migrations                               |
| `apps/api/prisma/sql`      | Operational SQL that is not a migration — roles, RLS check   |
| `apps/web`                 | Next.js agent console                                        |
| `packages/contracts`       | Zod schemas and types shared by both apps — the API contract |
| `packages/tsconfig`        | Shared TypeScript configuration                              |
| `docker-compose.yml`       | Local PostgreSQL and Redis                                   |
| `docker/postgres/initdb.d` | First-boot SQL for the local Postgres container              |
| `docs/adr`                 | Architecture decision records                                |

## Getting started

Requires **Node 22** (`.nvmrc`), **pnpm 9**, and **Docker** with Compose v2
(Docker Desktop covers both).

```bash
pnpm install                 # 1. dependencies
cp .env.example .env         # 2. config — the defaults match the Docker stack, no edits needed
pnpm db:up                   # 3. start PostgreSQL and Redis, wait until both are healthy
pnpm db:migrate:deploy       # 4. apply migrations to the empty database
pnpm db:roles                # 5. create the application database roles
pnpm dev                     # 6. run the API and the frontend
```

That is the whole setup. Step 3 blocks until both containers report healthy, so step 4
never races the database. Step 5 has to come after step 4 — it grants privileges on the
tables step 4 creates — and is idempotent, so re-running it is always safe.

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
```

The `checks` object is empty on purpose: the endpoint reports process liveness only and
must never claim dependency health it has not measured. Real database and queue probes
arrive with TAR-41.

**The database has tables but no rows — that is the expected state.** Seeding is TAR-46.
To see what step 4 built:

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
| `pnpm db:roles`          | Creates the application roles and their grants — run after migrations |
| `pnpm db:roles:down`     | Removes those roles                                                   |
| `pnpm db:verify:rls`     | Proves two tenants cannot see each other's rows                       |

The last three run `psql` inside the Postgres container against
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
`docker compose down -v && pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles` — equally
destructive, but it never invokes `migrate reset`. The `db:roles` step is not optional:
`down -v` destroys the volume, and the roles live in the cluster it took with it.

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
clause. All 33 tenant-scoped tables have `FORCE ROW LEVEL SECURITY` and one policy:

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
reconnects so the connection has genuinely never set the GUC, and asserts that all 33
tables return zero rows; that each tenant then sees its own rows and none of the other's;
that a cross-tenant insert is rejected and a cross-tenant update or delete matches
nothing. It exits non-zero on the first failure and cleans up after itself. CI runs it on
every pull request. It writes to the database it is pointed at, so point it at a local or
disposable one.

**RLS is a backstop, not the query plan.** The client extension still injects `tenantId`
into every `where`, and that is not belt-and-braces politeness — it is what keeps the
composite indexes usable. Measured locally on 50k conversations across 20 tenants, the
inbox query drops from an index-only scan reading 50 rows to a bitmap scan of the whole
tenant plus a top-N sort. The cause is that `enum_eq` is not leakproof, so under RLS a
`status = 'open'` qual cannot be pushed into the index condition. It does not matter at
this size and it will at a large tenant's; a partial index restores the original plan.
Nothing to do about it yet — recorded so that whoever sees it in a plan knows why.

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

## Continuous integration

`.github/workflows/ci.yml` runs four jobs — **Lint**, **Type-check**, **Test** and
**Database** — on every push to `main` and every pull request targeting it. They are the
commands above, so a run that is green locally is green in CI. **Database** starts the
Compose stack, applies the migrations, creates the roles and runs `pnpm db:verify:rls`;
tenant isolation is a property of the database rather than of any one function, so a unit
test cannot assert it. **Lint** covers both `pnpm format:check` and
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
