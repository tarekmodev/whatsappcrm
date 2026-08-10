# ADR 0002 — Observability stack, environment topology, and Render's backup coverage

- **Status**: Accepted
- **Date**: 2026-08-10
- **Issue**: TAR-41 (SaaS infra baseline), under TAR-34 / TAR-18
- **Author**: Senior Backend Engineer
- **Relates to**: ADR 0001 — resolves its open questions 4 and 5; does not supersede
  any decision in it.

## Context

ADR 0001 fixed the stack and the deployment target and deliberately left the
non-functional baseline to this task: how the platform logs, how exceptions are
tracked, how many environments exist and how they are separated, and how
migrations reach a database.

It also left two questions open that could not be answered without doing the work:

- **Open question 4** — does Render's managed Postgres actually cover backups and
  point-in-time recovery, and at which instance types? TAR-43's entire scope
  depends on the answer.
- **Open question 5** — Redis backs both the queue and realtime. What bounds the
  blast radius?

## Decisions

| #   | Concern              | Choice                                  | Alternatives considered               | Rationale                                                        |
| --- | -------------------- | --------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| 1   | Structured logging   | pino, behind one `AppLoggerService`     | winston; nestjs-pino                  | Fastest JSON logger; the tenant mixin is ours, not a plugin's    |
| 2   | Error tracking       | Sentry, behind `ErrorTrackingService`   | Rollbar; Bugsnag; logs only           | Best Node/Nest support; wrapped so the vendor stays replaceable  |
| 3   | Environment topology | 3 Render environments in one blueprint  | Blueprint per environment; per branch | One file to review, one sync, no drift between environments      |
| 4   | Health endpoints     | Split liveness and readiness            | One endpoint reporting everything     | A liveness check that fails on a DB blip causes a restart storm  |
| 5   | Migrations at deploy | `migrate deploy` in the pre-deploy hook | Release-phase job; manual step        | Same build as the code, and a failure aborts the deploy          |
| 6   | Migration reversal   | A `down.sql` per migration, CI-enforced | Accept irreversibility; switch ORM    | Closes ADR 0001's known Prisma gap without re-opening decision 6 |

### 1. Structured logging — pino behind one service

pino writes JSON to stdout, which is exactly what Render's log stream collects,
and it is fast enough that logging on the request path is not a latency decision.

The interesting part is not the library, it is the binding. A pino `mixin` reads
ADR 0001's `TenantContextService` on every write, so `requestId`, `tenantId` and
`userId` appear on every line emitted inside a request — and, because that context
is `AsyncLocalStorage`, inside a queue job and a WebSocket handler too, unchanged.
No call site passes a tenant id, so no call site can forget to.

- **Rejected — winston.** More transports and more formatting options. Rejected as
  slower, and because the transports it offers are ones a container should not use:
  a platform collects stdout.
- **Rejected — `nestjs-pino`.** Does most of this already. Rejected because it
  carries its own `AsyncLocalStorage` request context, which would sit alongside
  `TenantContextService` doing nearly the same job — two context mechanisms is
  precisely what ADR 0001 told downstream stories not to create. Roughly sixty
  lines of our own avoids that.

Credentials are redacted at the writer rather than at the call site: a call site
that must remember to strip a token is a call site that eventually does not.

### 2. Error tracking — Sentry, wrapped

Sentry is the default for a reason — Node and Nest support, stack traces with
source maps, release tagging, sane free tier. The choice worth recording is that
it is reached through `ErrorTrackingService` and nowhere else, so there is exactly
one place that decides what gets attached to an event. That matters here more than
usual: WhatsApp conversation content is personal data, `sendDefaultPii` is off, and
an audit of "what could leak into a third party" has one file to read.

Exceptions are captured from the global exception filter with `requestId` and
`tenantId` as tags, so an incident is filterable by tenant. 4xx responses are not
sent — an expected rejection is not an error, and a tracker full of 404s gets muted.

With no `SENTRY_DSN` the SDK is never initialised. Local development and CI carry
no tracker at all rather than a disabled one that still installs global handlers.

- **Rejected — Rollbar / Bugsnag.** Comparable. Rejected on smaller Nest-specific
  ecosystem and no reason to prefer them.
- **Rejected — logs only.** Cheaper and one fewer vendor. Rejected because TAR-34
  requires an error tracker with stack traces, and grouping, deduplication and
  regression detection are the actual product a tracker sells.

### 3. Environment topology — one blueprint, three environments

`render.yaml` declares `development`, `staging` and `production` under one Render
project, each with its own Postgres instance, Key Value instance, service pair and
environment group.

- **Rejected — one blueprint file per environment.** Cleaner to read individually.
  Rejected because Render syncs a blueprint from `render.yaml` at the repository
  root; per-environment files means per-branch blueprints, and three branches whose
  infrastructure silently diverges is the failure this is meant to prevent.
- **Rejected — environments as long-lived branches** (`develop`, `staging`, `main`).
  Rejected as ceremony for a squad this size: all three track `main` and differ in
  _when_ they deploy — development on commit, staging when CI passes, production
  only when promoted.

Deliberate consequences:

- Every instance type is **paid**. Free Postgres has no backups (see below) and free
  services sleep, which would make both TAR-43 and uptime alerting meaningless.
- Databases and Key Value instances have an **empty `ipAllowList`** — reachable only
  over Render's private network, never from the public internet.
- Provider credentials are per environment, and development and staging take the
  provider's _test_ credentials. Sending a real WhatsApp message to a real person
  from staging is a product incident, not a test failure.

### 4. Health endpoints — liveness and readiness are different questions

`GET /api/health` reports process liveness and probes nothing.
`GET /api/health/ready` probes PostgreSQL and Redis concurrently under a timeout,
returns `503` when either is down, and returns the full body either way so the
alert names the failing dependency.

- **Rejected — one endpoint.** Simpler. Rejected because whatever restarts an
  unhealthy instance would then restart every instance whenever the shared database
  hiccups, converting a recoverable dependency outage into a platform outage.

Neither endpoint is authenticated: an uptime monitor cannot hold a credential, and
the body carries a status and a short failure label — no host names, no versions of
anything but our own build, no connection strings.

### 5. Migrations at deploy — pre-deploy hook

`prisma migrate deploy` runs in Render's `preDeployCommand`, from the build that
produced the application code, before the new instance serves traffic. A failing
migration aborts the deploy and the previous instance keeps serving.

Services start with `exec node <entrypoint>`, not with a package script. This looks
like a triviality and is not: a dry run of the full pipeline in Linux containers
showed that `pnpm --filter … start` swallows `SIGTERM`, so Nest's shutdown hooks
never ran — every deploy would have cut in-flight requests, left Postgres and Redis
connections dangling, and discarded exactly the buffered Sentry events that explain
an incident. `exec` makes node PID 1 and the signal reaches its handler.
`LifecycleLoggerService` logs one line on shutdown so the difference is visible in
a log rather than inferred.

- **Rejected — a manual step in the runbook.** Rejected outright: TAR-34 requires
  migrations be applied automatically, and a manual step is one someone skips.
- **Rejected — running migrations at application boot.** Common and tempting.
  Rejected because every instance in a rolling deploy would race to run it, and a
  slow migration would look like a slow boot to the platform's health check.

### 6. Migration reversal — a `down.sql` convention, enforced by CI

ADR 0001 accepted Prisma knowing it does not generate down migrations, and left
this task to write the convention down. It is:

> every migration directory carries a `down.sql` beside Prisma's `migration.sql`,
> generated with `prisma migrate diff` and reviewed like code.

`pnpm --filter @whatsappcrm/api db:check-migrations` fails when one is missing, CI
runs it on every pull request, and `db:rollback` applies the newest one under a
Postgres advisory lock and deletes its `_prisma_migrations` row.

The convention is wrapped rather than documented, because the manual version has a
trap that fails silently. The down migration is the diff from the **new** datamodel
back to the **current database**, so it has to be captured _before_ `migrate dev`
applies anything — run the diff afterwards and Prisma emits
`-- This is an empty migration.`, which passes the CI check and reverses nothing.
`db:migrate` captures it in the right order, so nobody has to know that.
_(This was found the way you would expect: by doing it in the wrong order first.)_

ADR 0001 asked for verification that `prisma migrate diff` produces usable down SQL
for this schema's shape. **Verified against PostgreSQL 16** with a throwaway model:
create → apply → re-apply (no-op) → roll back → re-apply produced correct SQL and a
clean round trip. It has not been verified against a _realistic_ schema — there is
no data model until TAR-39 lands, and constraints, enums and foreign keys are where
generated rollbacks get interesting. TAR-42 should repeat the drill on the first
real migration; ADR 0001's recorded fallback (Drizzle) still stands if it turns out
to need more hand-editing than estimated.

- **Rejected — accepting irreversible migrations.** Rejected: TAR-34 names
  reversibility as acceptance criteria.
- **Rejected — switching to TypeORM for native up/down.** Rejected as re-opening a
  decision made two weeks ago on much broader grounds than this one gap.

## Answers to ADR 0001's open questions

### Open question 4 — Render backup and PITR coverage. **Answered.**

From Render's current documentation:

- **Free** Postgres instances get **no** logical backups and **no** PITR.
- **All paid** instance types get continuous backup with point-in-time recovery.
  The recovery window follows the _workspace_ plan: **3 days** on Hobby, **7 days**
  on Professional and above. PITR cannot restore to within ten minutes of now.
- Recovery creates a **new** instance at the chosen point in time, so the original
  can be validated against before anything is switched over.
- Logical backups can be exported from the dashboard on demand and are retained
  seven days regardless of plan.

Every environment in `render.yaml` is on a paid instance type specifically so this
holds. **The consequence for TAR-43 is that ADR 0001's expectation stands: it is
not "build a backup system".** It is confirm the schedule and retention against the
provisioned instances, document them, and perform and record a real restore drill.

Still to confirm at the account level, which needs the Render workspace: which
workspace plan is in effect, and therefore whether the window is 3 or 7 days.

### Open question 5 — Redis as a shared dependency. **Bounded, not eliminated.**

Each environment has its own Key Value instance, so a development load spike cannot
starve production. Within an environment the queue and realtime still share one
instance; separating them is a change to make when there is load to justify it, not
before.

Two things bound the damage today: `maxmemoryPolicy: noeviction`, so the queue
loses work loudly under memory pressure rather than silently, and ADR 0001's
durability rule — the webhook path persists to PostgreSQL before it enqueues — which
keeps Redis a latency dependency rather than a durability one.

## Consequences for downstream issues

- **TAR-39** — an exception filter and the `ApiError` envelope now exist. Error
  _codes_ are derived from the HTTP status as a placeholder; the taxonomy is still
  yours, and a thrown `HttpException` can already carry its own `code`.
- **TAR-42** — `apps/api/prisma/schema.prisma` and the `db:*` scripts exist. Point
  docker-compose at them; do not introduce a second migration entry point.
- **TAR-43** — start from "answered" above. Confirm the workspace plan, document
  the window, run the drill.
- **TAR-45** — verify readiness against a deployed environment, not locally: it
  reports `down` with no database, which is correct behaviour, not a failure.

## Open questions and risks

| #   | Item                                                                                                                            | Severity | Proposed resolution                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------- |
| 1   | Nothing in this repository can create Render or Sentry accounts. Provisioning and external uptime alerting need credentials     | **High** | Raised on TAR-41; blocks TAR-43                           |
| 2   | Data residency (ADR 0001 open question 1) is still assumed not to apply. Frankfurt is the closest Render region to Saudi Arabia | Medium   | Confirm before production holds real tenant data          |
| 3   | No background worker service is declared — BullMQ is not installed yet, so there is nothing to run                              | Medium   | The story that adds the queue adds a `worker` service     |
| 4   | Log volume and retention are Render's defaults. A busy tenant could make the request log the dominant cost                      | Low      | Revisit with real traffic; `LOG_LEVEL` is per environment |
