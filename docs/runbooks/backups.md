# Backups and restore

What backs up each database, how often, how far back it reaches, how to get data
back, and how we know any of that is true.

- **Issue**: TAR-43, under TAR-34 / TAR-18
- **Depends on**: ADR 0002 (which answered whether Render covers this at all),
  `render.yaml` (which is why every instance type is paid)
- **See also**: [environments runbook](environments.md) for provisioning and
  rollback, [migrations runbook](migrations.md) for schema changes

## The short version

We do not run a backup system. Render's managed Postgres does, on every
environment, because every environment is on a paid instance type
(`render.yaml`). Our job is three things: know what that coverage actually is,
know how to use it under pressure, and prove periodically that what comes back
is the database we put in. The third is `pnpm db:restore-drill`.

Redis is not backed up and does not need to be — see [Redis](#redis-is-not-backed-up).

## Coverage

| Environment | Instance                 | Plan          | Continuous backup + PITR | Recovery window       |
| ----------- | ------------------------ | ------------- | ------------------------ | --------------------- |
| development | `whatsappcrm-db-dev`     | `basic-256mb` | Yes                      | Workspace plan, below |
| staging     | `whatsappcrm-db-staging` | `basic-256mb` | Yes                      | Workspace plan, below |
| production  | `whatsappcrm-db-prod`    | `basic-1gb`   | Yes                      | Workspace plan, below |

**Schedule.** Continuous, not nightly. Render streams write-ahead log segments off
the instance as they are produced, so the recovery target is any timestamp in the
window rather than the last time a job happened to run. There is no cron entry to
audit and no job of ours that can silently stop.

**Recovery window** follows the _workspace_ plan, not the instance plan: 3 days on
Hobby, 7 days on Professional and above. PITR cannot restore to within roughly ten
minutes of now — the most recent segments have not been archived yet.

**Logical backups**, exportable from the Render dashboard on demand, are retained
7 days regardless of plan. These are the ones to hand to the restore drill, and
the only ones that can be restored somewhere that is not Render.

> **Open, needs the Render account.** Which workspace plan is in effect, and so
> whether the window is 3 days or 7. Everything else in this table follows from
> `render.yaml` and is true the moment the blueprint syncs; this one number does
> not, and it is the difference between "we can recover from a Friday mistake on
> Monday" and "we cannot". Confirm it at the first sync and correct this table.

### What the window means in practice

| Failure                                | Recovery                               | Data lost                     |
| -------------------------------------- | -------------------------------------- | ----------------------------- |
| Bad migration caught in minutes        | `db:rollback`, not a restore           | None                          |
| Bad migration caught in hours          | PITR to just before it                 | Everything written since      |
| `DELETE` without a `WHERE`, one tenant | PITR to a new instance, copy rows back | None, if caught in the window |
| Instance lost entirely                 | PITR to a new instance                 | Up to ~10 minutes             |
| Anything older than the window         | **Nothing.** There is no recovery.     | All of it                     |

That last row is the reason the workspace plan matters, and the reason a
destructive migration takes an on-demand logical backup first regardless of what
the continuous coverage says.

## Restoring on Render

Render's recovery **creates a new instance** at the chosen timestamp; it does not
overwrite the existing one. That is a feature under pressure — the damaged
database is still there to compare against, and nothing is switched over until
someone decides to.

1. Render → the database → **Recovery** → pick the timestamp. Pick a point
   _before_ the event, not at it.
2. Wait for the new instance. Do not touch the original.
3. Point a psql session at the new instance and confirm the data you came for is
   actually there, at the granularity you care about — a row count on the
   affected table, not "it started".
4. Decide: promote the recovered instance (update `DATABASE_URL`,
   `APP_DATABASE_URL` and `SYSTEM_DATABASE_URL` in that environment's group,
   redeploy), or extract the rows you need and copy them into the live database.
   For a single-tenant mistake, the second is almost always right — promoting
   rolls back every other tenant too.
5. If you promote: the application roles are cluster state, not database state,
   and a new instance does not have them. Run
   `pnpm --filter @whatsappcrm/api db:provision-roles` against it _before_
   pointing the API at it, or every request fails to authenticate. The deploy's
   pre-deploy hook does this, so a redeploy covers it; a manual cutover does not.

Step 5 is the one that bites. Ownership and `GRANT`s travel with a logical dump,
but the roles they name do not, and neither a PITR instance nor a fresh restore
starts with `whatsappcrm_app` and `whatsappcrm_system`.

## The restore drill

> **An untested backup is not a backup.** Provider dashboards report that
> backups exist. They do not report that a restored database still has its
> row-level security policies, and a restore that silently loses those turns
> every tenant's data into everyone's.

`pnpm db:restore-drill` dumps a database, restores it into a scratch target, and
diffs the two on eleven dimensions:

| Check                       | Catches                                                         |
| --------------------------- | --------------------------------------------------------------- |
| migrations applied          | A restore from a different schema version than you think        |
| columns                     | Type or nullability drift                                       |
| indexes                     | Indexes not recreated — a working but unusably slow restore     |
| constraints                 | `NOT VALID` constraints, missing foreign keys                   |
| enum labels                 | Label order, which `ORDER BY` on an enum depends on             |
| functions                   | `assert_tenant_active` and the RLS helpers                      |
| row-level security flags    | `FORCE ROW LEVEL SECURITY` lost on any table                    |
| row-level security policies | Any policy predicate changed or missing                         |
| table grants                | `--no-privileges` restores, missing roles                       |
| extensions                  | `citext` / `pgcrypto` absent — citext columns come back as text |
| row counts                  | Rows that did not come back                                     |

Any difference is a non-zero exit and a printed diff of the offending rows.

### Running it locally

```bash
pnpm db:up               # compose stack
pnpm db:migrate:deploy   # migrated schema
pnpm db:canary           # rows to compare, if you have not seeded (see below)
pnpm db:restore-drill
```

It needs no PostgreSQL client tools installed: if `pg_dump` is not on `PATH` it
runs the client binaries in a throwaway container instead.

**It needs rows.** A drill against an empty database verifies the schema and
proves nothing about data, and the script says so. Run it against a seeded
database (TAR-46's dataset) when there is one; `pnpm db:canary` loads a much
smaller fixture — one tenant, deliberately including non-ASCII text, `citext`,
`jsonb`, `inet` and both `message_direction` values, because those are the column
types a dump/restore round trip actually gets wrong.

### Running it against a Render database

Two things change.

**Client version.** `pg_dump` refuses to dump a server newer than itself. Render
runs Postgres 16 and the compose stack runs 17, so dumping Render needs the 16
client:

```bash
pnpm db:restore-drill -- \
  --source-url "$STAGING_DATABASE_URL" \
  --client-image postgres:16-alpine
```

**The target.** Render's database user has no `CREATEDB`, so the drill cannot
create its scratch database on the same server. Either restore into the local
compose stack (fine, and the usual choice — a 17 client restores a 16 dump
without complaint), or provision a scratch Render instance and pass
`--no-create-target` with a target that is already empty.

Never point `--source-url` at production while people are using it: the dump
holds a transaction open for its duration, and the drill exists to be run on
staging.

### Cadence

- **Every time the schema changes shape** — a migration that adds a table,
  a policy or an extension. The drill is three seconds locally; there is no
  reason to batch it.
- **Monthly against staging**, from a real Render logical backup, so the drill
  exercises the provider's export path and not only `pg_dump`.
- **Before any destructive migration**, against the environment it will run in.
  Take an on-demand logical backup in the same sitting.
- **After the first Render sync**, to confirm the coverage table above.

Record each staging or production drill below. A drill nobody wrote down did not
happen.

## Drill log

| Date       | Source                                                                      | Target                                   | Result                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-11 | Local compose Postgres 17.10, migrated to `20260811130000` + canary fixture | `whatsappcrm_restore_drill`, same server | **Pass.** 40 tables, 23 rows, 12 migrations. Identical on all 11 checks — 367 columns, 139 indexes, 112 constraints, 72 policies, 582 grants. Dump 1.1s, restore 1.7s. |

The first entry is a local drill, not a Render one: the Render account does not
exist yet (blocked on credentials, raised on TAR-41), so there is no staging
instance to dump. It verifies the dump/restore path, the comparison and the
tooling; it does not verify Render's backup product. The monthly staging drill
above is what closes that gap, and its first run is due the week the blueprint
syncs.

## Redis is not backed up

Deliberate, per ADR 0002. Each environment's Key Value instance holds queue state
and Socket.IO adapter state — work in flight, not a record of anything. Losing it
loses in-flight jobs, which are re-derivable: `webhook_events` is written to
Postgres at the ingest boundary before anything is enqueued, so a lost queue is
replayed from the database rather than restored from a backup. It is configured
`noeviction` for the same reason — silently dropping a job under memory pressure
would be the failure a backup could not fix either.

## What is not covered

- **Media.** WhatsApp media lives with the provider and in `media_objects` as
  references. A database restore restores the references, not the bytes.
- **Secrets.** Render environment groups are not in any backup here. They are
  reconstructed from `render.yaml` plus the values, which live only in Render and
  in whatever the team uses to hold them.
- **Anything older than the recovery window.** There is no long-term archive and
  no compliance retention policy yet. If a contract ever requires one, it is a
  new decision and a new job, not a setting on this page.
