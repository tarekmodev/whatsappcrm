# WhatsApp CRM

Multi-tenant, white-label WhatsApp CRM and helpdesk platform, built on the official
WhatsApp Business Cloud API.

> **Status: scaffold.** This repository currently contains the project skeleton, the stack
> decision and the local development harness — no product features. Feature work is
> tracked as the TAR-18 epic. The database has **no tables yet**: entities arrive with
> TAR-39 and seed data with TAR-46. Everything below works today.

## Stack

TypeScript on Node 22 · NestJS 11 API · Next.js 16 frontend · PostgreSQL · Prisma ·
Socket.IO · BullMQ on Redis · deployed to Render.

Every one of those choices, the alternatives weighed against it, and the failure modes
they imply are recorded in **[`docs/adr/0001-stack-decision.md`](docs/adr/0001-stack-decision.md)**.
Read that before proposing a change to any of them.

Prisma is installed as a **CLI only** — schema and migrations, no generated client and no
`@prisma/client` dependency. Prisma 7 clients need a driver adapter, which is a decision
for the story that writes the first query rather than one to inherit. Socket.IO and BullMQ
are decided but not yet installed; each arrives with the story that first needs it.

## Layout

| Path                       | What it is                                                   |
| -------------------------- | ------------------------------------------------------------ |
| `apps/api`                 | NestJS HTTP API                                              |
| `apps/api/prisma`          | Database schema and migrations                               |
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
pnpm dev                     # 5. run the API and the frontend
```

That is the whole setup. Step 3 blocks until both containers report healthy, so step 4
never races the database.

`pnpm dev` runs both apps: the API on <http://localhost:3001/api> and the frontend on
<http://localhost:3000>.

### Check it worked

```bash
curl http://localhost:3001/api/health
# {"status":"ok","version":"0.0.0","uptimeSeconds":3,"checks":{}}

pnpm db:migrate:status
# Database schema is up to date!
```

The `checks` object is empty on purpose: the endpoint reports process liveness only and
must never claim dependency health it has not measured. Real database and queue probes
arrive with TAR-41.

**The database is migrated but empty — that is the expected state.** There are no tables
because there are no entities yet (TAR-39), and no rows because seeding is TAR-46. What
step 4 proves is that the migration runner reaches your local database and records what it
applied. To see that for yourself:

```bash
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
`docker compose down -v && pnpm db:up && pnpm db:migrate:deploy` — equally destructive, but
it never invokes `migrate reset`.

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

### Adding a migration

Edit `apps/api/prisma/schema.prisma`, then:

```bash
pnpm db:migrate --name add_conversations
```

That writes `apps/api/prisma/migrations/<timestamp>_add_conversations/migration.sql` and
applies it. **Read the generated SQL before committing it** — Prisma will happily emit a
statement that rewrites a large table or takes a long lock, and neither is visible from
the schema diff.

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

`.github/workflows/ci.yml` runs three jobs — **Lint**, **Type-check** and **Test** — on
every push to `main` and every pull request targeting it. They are the commands above, so
a run that is green locally is green in CI. **Lint** covers both `pnpm format:check` and
`pnpm lint`, in that order: Prettier owns formatting and ESLint owns everything else, per
ADR 0001's decision 12. An unformatted file therefore fails the **Lint** check — run
`pnpm format` and push again.

`main` is protected, and the three checks are **required** — they gate the merge rather
than merely reporting on it. The branch must also be up to date with `main` before
merging, review threads must be resolved, administrators are included, and force pushes
and branch deletion are blocked.

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
