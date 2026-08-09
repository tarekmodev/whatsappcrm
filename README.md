# WhatsApp CRM

Multi-tenant, white-label WhatsApp CRM and helpdesk platform, built on the official
WhatsApp Business Cloud API.

> **Status: scaffold.** This repository currently contains the project skeleton and the
> stack decision only — no product features. Feature work is tracked as the TAR-18 epic.
> The full local-development guide, including a seeded database, is owned by TAR-42; the
> steps below are what works today.

## Stack

TypeScript on Node 22 · NestJS 11 API · Next.js 16 frontend · PostgreSQL · Prisma ·
Socket.IO · BullMQ on Redis · deployed to Render.

Every one of those choices, the alternatives weighed against it, and the failure modes
they imply are recorded in **[`docs/adr/0001-stack-decision.md`](docs/adr/0001-stack-decision.md)**.
Read that before proposing a change to any of them.

Prisma, Socket.IO and BullMQ are decided but not yet installed — each arrives with the
story that first needs it.

## Layout

| Path                 | What it is                                                   |
| -------------------- | ------------------------------------------------------------ |
| `apps/api`           | NestJS HTTP API                                              |
| `apps/web`           | Next.js agent console                                        |
| `packages/contracts` | Zod schemas and types shared by both apps — the API contract |
| `packages/tsconfig`  | Shared TypeScript configuration                              |
| `docs/adr`           | Architecture decision records                                |
| `docs/runbooks`      | Operational procedures — environments, migrations            |
| `render.yaml`        | The three hosted environments, defined as a Render blueprint |

## Getting started

Requires **Node 22** (`.nvmrc`) and **pnpm 9**.

```bash
pnpm install
cp .env.example .env     # defaults are enough to boot the scaffold
pnpm dev
```

`pnpm dev` runs both apps: the API on <http://localhost:3001/api> and the frontend on
<http://localhost:3000>.

Check the API is up:

```bash
curl http://localhost:3001/api/health
# {"status":"ok","version":"0.0.0","uptimeSeconds":3,"checks":{}}
```

No database or Redis is needed to boot locally — `DATABASE_URL` and `REDIS_URL` are
optional outside production. Readiness will report `down` until they are set, which is
the correct answer, not a failure. TAR-42 adds the docker-compose harness that supplies
them.

## Commands

Run from the repository root; Turborepo fans each one out across the workspaces.

| Command          | What it does                                        |
| ---------------- | --------------------------------------------------- |
| `pnpm dev`       | Runs the API and the frontend in watch mode         |
| `pnpm build`     | Builds every package                                |
| `pnpm typecheck` | Type-checks every package                           |
| `pnpm test`      | Runs all tests — Jest for the API, Vitest elsewhere |
| `pnpm lint`      | ESLint across the whole repository                  |
| `pnpm format`    | Applies Prettier                                    |

Database commands run from `apps/api` (or with `pnpm --filter @whatsappcrm/api <script>`):

| Command               | What it does                                                      |
| --------------------- | ----------------------------------------------------------------- |
| `db:migrate --name X` | Creates a migration **and** its `down.sql`. Local only            |
| `db:deploy`           | Applies pending migrations — what runs on every deploy            |
| `db:rollback`         | Prints the plan to undo the newest migration; `--confirm` runs it |
| `db:check-migrations` | Fails if any migration has no `down.sql`. CI runs this            |
| `db:generate`         | Regenerates the Prisma client                                     |

## Environments

Three hosted environments — development, staging and production — each with its own
database, its own Key Value instance and its own WhatsApp and Polar credentials. They
are defined in [`render.yaml`](render.yaml); provisioning them, the secrets you are
prompted for, and the alerting wired to them are in
[`docs/runbooks/environments.md`](docs/runbooks/environments.md).

Health:

| Endpoint            | Answers                           |
| ------------------- | --------------------------------- |
| `/api/health`       | is the process alive              |
| `/api/health/ready` | can it serve — database and queue |

`/api/health/ready` answers `503` when a dependency is down and still returns the full
body, so an alert says which one.

Migrations apply automatically as part of every deploy and each one ships a
hand-written `down.sql` — see
[`docs/runbooks/migrations.md`](docs/runbooks/migrations.md).

## Continuous integration

`.github/workflows/ci.yml` runs three jobs — **Lint**, **Type-check** and **Test** — on
every push to `main` and every pull request targeting it. They are exactly the three
commands above, so a run that is green locally is green in CI.

> **`main` is not protected yet, so CI reports but does not block a merge.** GitHub gates
> branch protection _and_ repository rulesets on a private repository behind a paid plan,
> and `tarekmodev` is on Free. Both APIs answer with a 403 telling you to upgrade to
> GitHub Pro or make the repository public. This is a plan limit, not a permissions one:
> the token holds repository admin. Until the plan or the repository visibility changes, a
> red pull request can still be merged. Tracked on TAR-40.

The rule to apply the moment that is unblocked: require **Lint**, **Type-check** and
**Test**, require the branch to be up to date with `main` before merging, include
administrators, and block force pushes and deletion. Renaming a job renames its required
check, so update the rule in the same change.

Lint runs `typescript-eslint`'s type-aware rules, which has two consequences worth
knowing. Every linted TypeScript file needs a `tsconfig` that covers it — a new `.ts`
file outside one fails lint with a parsing error rather than being silently skipped. And
the rules resolve `@whatsappcrm/contracts` through its build output, so `pnpm lint`
builds `packages/*` first; without that, a clean checkout lints an unresolved type as
`any` and reports errors that do not exist.

## Configuration

`.env.example` is the documented contract for every environment variable and is the file
to update when a key is added. It holds **no values** — deployed environments read their
secrets from the platform's secret store, never from a committed file.

For the API, `.env.example` must stay in sync with
`apps/api/src/config/env.schema.ts`, which validates the environment at boot and refuses
to start if a required key is missing or malformed.

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
  which ties a user-reported error to a log line. Throwing an `HttpException` is enough
  — `AllExceptionsFilter` turns it into that envelope, logs it, and reports the 5xx ones
  to the error tracker.
- **Never `console.log`.** Nest's `Logger` writes through `AppLoggerService`, which
  emits JSON and attaches the tenant automatically. For structured fields, inject
  `AppLoggerService` and call `structured('MyContext')`.
- **Never read `process.env`.** Add the key to `apps/api/src/config/env.schema.ts` and
  `.env.example` in the same commit, then read it from `ConfigService`. The process
  refuses to boot on an invalid environment.

## License

MIT — see [LICENSE](LICENSE).
