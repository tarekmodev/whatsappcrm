# Environments, secrets and alerting

Three hosted environments, one blueprint. `render.yaml` at the repository root is
the definition — everything below is how to apply it and the two things a
blueprint cannot express.

| Environment   | Deploys                  | Database                 | Key Value                | Provider credentials |
| ------------- | ------------------------ | ------------------------ | ------------------------ | -------------------- |
| `development` | every commit to `main`   | `whatsappcrm-db-dev`     | `whatsappcrm-kv-dev`     | provider **test**    |
| `staging`     | `main`, once CI is green | `whatsappcrm-db-staging` | `whatsappcrm-kv-staging` | provider **test**    |
| `production`  | manual promotion only    | `whatsappcrm-db-prod`    | `whatsappcrm-kv-prod`    | provider **live**    |

Nothing is shared across the rows. Separate databases, separate Key Value
instances, separate environment groups, separate WhatsApp and Polar credentials.

All resources are in Render's **Frankfurt** region — the closest Render offers to
the client's Saudi base. Render has no Middle East region. Confirmed acceptable by
Tarek on 2026-08-10; ADR 0002 records the decision and what would reopen it.
WhatsApp conversation content is personal data, so adding a cross-region replica,
backup target, log destination or analytics export reopens that decision rather
than being a configuration detail.

## What it costs

Twelve billable resources — four per environment. Every tier is paid on purpose:
free Postgres has no backups or point-in-time recovery (TAR-43 depends on them),
and free instances sleep, which would make the uptime alerting below meaningless.

| Environment | API service | Web service | Key Value | Postgres    |
| ----------- | ----------- | ----------- | --------- | ----------- |
| development | Starter     | Starter     | Starter   | Basic-256mb |
| staging     | Starter     | Starter     | Starter   | Basic-256mb |
| production  | Standard    | Standard    | Standard  | Basic-1gb   |

At Render's published rates, development and staging are about **$30/month each**
(Starter service $7, Starter Key Value $10, Basic-256mb Postgres $6). Production's
two Standard services are $25 each; its Postgres and Key Value tiers cost more
than the Starter figures above — **confirm the exact numbers on Render's pricing
page before syncing**, and budget roughly $150–$180/month in total. Signed off by
Tarek on 2026-08-10.

The obvious trim, if that lands badly: drop the hosted `development` environment
and rely on TAR-42's local Docker stack, saving ~$30/month. It is not done here
because TAR-34 names three environments as an acceptance criterion — removing one
is a scope decision, not an implementation detail.

## Provisioning

> Requires a Render workspace on a **paid plan** and repository access. This is
> the step that needs an account: everything above it is in the repository.

**You do not need every credential to start.** Only six values actually matter for
the first sync, and all six are predictable — see below. Everything else can be a
placeholder and be filled in by the story that first reads it.

1. Render Dashboard → **New** → **Blueprint**, pick `tarekmodev/whatsappcrm`,
   branch `main`. Render reads `render.yaml`.
2. Render prompts once per `sync: false` variable, **per environment**. Fill the
   six URLs from the table below; put `placeholder` in the rest. Values are stored
   in Render and nowhere else.
3. Apply. Render creates the databases, the Key Value instances, the services and
   the environment groups, then runs the first build and `prisma migrate deploy`.
4. **Check the assigned hostnames.** Render appends a suffix if a service name is
   already taken globally. If any differ from the predicted URLs, correct
   `WEB_ORIGIN` and `NEXT_PUBLIC_API_BASE_URL` for that environment and redeploy —
   a wrong `WEB_ORIGIN` shows up as CORS failures in the browser, not as a failed
   deploy.
5. Confirm each environment answers on its readiness endpoint:
   `curl -i https://<api-host>/api/health/ready` → `200`, with
   `checks.database.status` and `checks.queue.status` both `ok`.
6. Record each environment's API and web hostnames in the project resources so
   TAR-43 and TAR-45 do not have to go looking for them.

### The database roles

The API connects as two non-superuser roles, `whatsappcrm_app` and
`whatsappcrm_system` (TAR-48/TAR-49) — never as the migration owner, which on a
managed instance is a superuser and would skip row-level security entirely.

`pnpm db:roles` creates them locally through `docker compose exec`, which reaches
nothing in a deployed environment. So the pre-deploy hook runs
`db:provision-roles` after the migrations: it applies the same
`prisma/sql/app-roles.sql`, then sets each role's password from
`APP_DATABASE_PASSWORD` / `SYSTEM_DATABASE_PASSWORD`. It is idempotent and runs on
every deploy, which is also how a newly added table gets its grants.

That leaves four values per environment that have to agree with each other:

1. Generate two passwords: `openssl rand -hex 32`, once per role per environment.
2. Put them in `APP_DATABASE_PASSWORD` and `SYSTEM_DATABASE_PASSWORD`.
3. Build `APP_DATABASE_URL` and `SYSTEM_DATABASE_URL` from the Render database's
   own connection string, swapping the user and password:

   ```
   # Render gives you, for the owner:
   postgresql://whatsappcrm:<owner-pw>@<host>/whatsappcrm

   # so use, with the password from step 2:
   APP_DATABASE_URL=postgresql://whatsappcrm_app:<app-pw>@<host>/whatsappcrm
   SYSTEM_DATABASE_URL=postgresql://whatsappcrm_system:<system-pw>@<host>/whatsappcrm
   ```

**Nothing checks that the password and the URL agree** until the API fails to
authenticate on first boot. If a deploy comes up with readiness reporting the
database down and `detail` showing an authentication failure, this is why.

> A cleaner shape exists: derive both URLs from `DATABASE_URL` plus the two
> passwords, so the host can never be mistyped and there is one value per role
> instead of two. That changes TAR-49's configuration contract, so it is raised
> with them rather than done here.

### The six values that matter

Render assigns `https://<service-name>.onrender.com`, and the service names are
fixed in `render.yaml` — so these are known before anything exists:

| Environment | `WEB_ORIGIN`                                   | `NEXT_PUBLIC_API_BASE_URL`                         |
| ----------- | ---------------------------------------------- | -------------------------------------------------- |
| development | `https://whatsappcrm-web-dev.onrender.com`     | `https://whatsappcrm-api-dev.onrender.com/api`     |
| staging     | `https://whatsappcrm-web-staging.onrender.com` | `https://whatsappcrm-api-staging.onrender.com/api` |
| production  | `https://whatsappcrm-web-prod.onrender.com`    | `https://whatsappcrm-api-prod.onrender.com/api`    |

They are prompted rather than wired automatically because Render's `fromService`
supplies a hostname with no scheme, and both of these need one. They become custom
domains once white-labelling lands.

### Everything else can wait

| Key                                                                                                         | When it is actually needed                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                                                                                                | Optional. With no DSN the SDK is never started and errors still reach the structured log. Add per environment whenever a Sentry project exists — it is a variable change and a redeploy, no rebuild. |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | When the WhatsApp integration lands. No code reads them yet, which is why they are absent from `env.schema.ts`. Generate the verify token yourself: `openssl rand -hex 32`.                          |
| `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`                                                                | TAR-37. Polar sandbox for development and staging, live only for production.                                                                                                                         |

`DATABASE_URL` and `REDIS_URL` are **not** prompted: the blueprint wires them from
the database and Key Value instance in the same environment, so they cannot be
pointed at the wrong one by hand.

### Rules

- **No secret ever reaches the repository.** `.env.example` documents the shape
  and holds no values; `.gitignore` excludes every `.env*` but the example.
- **Production credentials are entered, never copied down.** Copying a live
  WhatsApp token into staging means test traffic sends real messages to real
  people.
- **Never use a free instance type.** Free Postgres has no backups and no
  point-in-time recovery, and free instances sleep — which breaks both TAR-43 and
  the uptime alerting below.
- **Rotation** is: change the value in the Render environment group, redeploy.
  No rebuild, no code change.

## Health, and the alerting wired to it

Two endpoints, deliberately different:

| Endpoint            | Answers                        | Used by                             |
| ------------------- | ------------------------------ | ----------------------------------- |
| `/api/health`       | is the process alive           | nothing automated; debugging        |
| `/api/health/ready` | can it serve — database, queue | Render health check, uptime monitor |

`/api/health/ready` returns `200` when both dependencies answer and `503` when
either does not, and it returns the full body either way — so an alert says
_which_ dependency is down rather than only that something is:

```json
{
  "status": "down",
  "version": "9f2c1ab",
  "uptimeSeconds": 412,
  "checks": {
    "database": { "status": "ok" },
    "queue": { "status": "down", "detail": "connection is reconnecting" }
  }
}
```

Liveness deliberately probes nothing. A liveness check that fails when the
database blinks tells the platform to restart a healthy process, turning a
dependency outage into a restart storm on top of it.

Both probes are bounded by `HEALTH_CHECK_TIMEOUT_MS` and run concurrently, so a
hung dependency produces a `503` rather than a request that never answers.

### What is wired

`healthCheckPath: /api/health/ready` is set on every API service in
`render.yaml`. Render uses it to gate a deploy — an instance that never becomes
ready is not rolled into — and to replace an instance that stops being ready.

### What still needs an account (open)

Render's own health check does not page anyone. External uptime alerting is
account-level configuration, not blueprint configuration, and could not be
created from this task — see the note on this issue. To finish it:

1. Create one monitor per environment against
   `https://<api-host>/api/health/ready`, expecting `200`.
2. Interval: 1 minute for production, 5 minutes for staging and development.
   Alert after 2 consecutive failures, so a single deploy restart is not a page.
3. Route production alerts to a channel that pages; development and staging to a
   channel that does not.
4. In Render, add notification settings for **deploy failed** and **service
   unhealthy** on the production services.

## Deploys and shutdown

Each service starts with `exec node <entrypoint>` rather than a package script.
That is load-bearing, not style: `exec` makes node PID 1, so Render's `SIGTERM`
reaches Nest's shutdown hooks. Run it through `pnpm start` instead and the signal
never arrives — the process is killed outright, cutting in-flight requests,
leaving database and Redis connections dangling, and discarding buffered
error-tracker events on every deploy. This was measured, not assumed.

A clean shutdown logs one line before exiting:

```json
{ "context": "Lifecycle", "signal": "SIGTERM", "msg": "shutting down: draining connections" }
```

If a container's final output does not contain it, the process was killed rather
than drained — which also means the errors explaining _why_ it died never reached
Sentry. That line is the first thing to check when a deploy looks unhealthy.

The API also refuses to boot at all if a required variable is missing, naming the
key:

```
Error: Invalid environment configuration:
  - DATABASE_URL: is required when NODE_ENV=production
```

That is a failed deploy with an obvious cause, which is the point — the previous
instance keeps serving.

## Logging and error tracking

Logs are structured JSON on stdout, which is what Render's log stream collects.
Every line carries `service`, `env`, `version`, and — for anything running inside
a request, a queue job or a WebSocket handler — `requestId`, `tenantId` and
`userId`, read from `TenantContextService` (ADR 0001). No call site passes them.

- Every completed request logs `method`, `path` (query string stripped), status
  and `durationMs`. A request at or above `SLOW_REQUEST_THRESHOLD_MS` is logged at
  `warn` with `slow: true`, as is any 5xx or client-aborted request.
- Unhandled exceptions are logged at `error` with the stack and sent to Sentry,
  tagged with `requestId` and `tenantId`. Expected client errors (4xx) are logged
  at `warn` and are **not** sent to the tracker.
- Credentials are redacted at the writer — `authorization`, `cookie`, `password`,
  `token`, `apiKey`, `secret` and friends never reach the log destination.
- With no `SENTRY_DSN` the SDK is never started. That is the local and CI default.

To find one user's failed request: take the `x-request-id` from the error they
were shown, search the environment's logs for it, and search Sentry for the same
value.

## Rollback

- **Application**: Render → the service → **Deploys** → roll back to the previous
  successful deploy. Do this first; diagnose second.
- **Schema**: `pnpm --filter @whatsappcrm/api db:rollback --confirm` against that
  environment's `DATABASE_URL`. See docs/runbooks/migrations.md.
- Roll the application back before the schema. Migrations are additive within a
  release, so the previous application version runs against the new schema —
  which is what makes rolling back code alone safe.

## Backups

Provider-managed, per ADR 0002. Every environment is on a paid Postgres instance
type, which is what makes that true. Continuous backup with point-in-time
recovery, no job of ours to audit.

Schedule, recovery window, how to restore on Render, and the restore drill that
proves a restore still has its RLS policies: docs/runbooks/backups.md.

One thing worth knowing here rather than there: Render recovery creates a **new**
instance, and the application roles are cluster state that a new instance does not
have. Run `pnpm --filter @whatsappcrm/api db:provision-roles` against it before
pointing the API at it, or every request fails to authenticate.
