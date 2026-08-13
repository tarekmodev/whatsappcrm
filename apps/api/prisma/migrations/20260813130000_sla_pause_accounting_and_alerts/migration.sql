-- SLA pause accounting, the sweep's index, and the supervisor alert (TAR-270).
--
-- The schema half of TAR-26, built against
-- `docs/architecture/0006-sla-timers-and-supervisor-alerts.md`. Three things:
--
--   1. `sla_timers` gains the three columns a pause needs and the index the
--      breach sweep reads (0006, "Data Model" and decisions 1–2).
--   2. `sla_alerts` — new. One row per recipient per breached timer: the
--      delivery record, the read model, and the idempotency ledger (decision 5).
--   3. Every existing tenant gets the default SLA policy row that decision 6
--      makes the configuration surface. New tenants get theirs from
--      `TenantProvisioningService`; this is the backfill for the ones already
--      provisioned.
--
-- ---------------------------------------------------------------------------
-- What this migration deliberately does NOT do: touch `tickets`
-- ---------------------------------------------------------------------------
--
-- TAR-270's acceptance criteria propose `tickets.first_response_due_at` and an
-- overdue flag. 0006 supersedes that, and the reasoning is worth restating where
-- the SQL is: the deadline moves on every pause and resume, so a copy on
-- `tickets` is a second source of truth that pause/resume has to keep in step,
-- and the failure mode when it drifts is a *false* breach alert. The deadline
-- and the state live on `sla_timers`; `breachedOnly` is an `EXISTS` against it,
-- served by the existing `UNIQUE (tenant_id, ticket_id, kind)`.
--
-- That also answers TAR-270's coordination check against TAR-25 (Ticket status &
-- priority management, in progress at the time of writing) outright: this
-- migration issues no `ALTER TABLE tickets`, so there is nothing for TAR-25's DB
-- work to collide with, in either order.
--
-- `tickets.first_response_at` already exists and has never been written by any
-- code path. TAR-280 writes it; no column change is needed for that.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds today. `sla_timers` holds zero rows in every
--                environment — TAR-47 landed the table, nothing has ever
--                written it, and the count is asserted below rather than
--                assumed. `sla_alerts` is created empty. The backfill inserts
--                at most one row per tenant.
--
--                At production-ish row counts, which is what TAR-270 asks to be
--                documented, the three statements age differently:
--
--                  * `ADD COLUMN paused_at/breached_at` (nullable, no default)
--                    and `ADD COLUMN paused_ms integer NOT NULL DEFAULT 0` are
--                    all metadata-only in PostgreSQL 11+ — a constant default is
--                    stored in `pg_attribute` and materialised lazily, so none
--                    of the three rewrites the table. Milliseconds at 10 rows or
--                    10 million.
--                  * The two index builds are the part that scales. Built
--                    non-concurrently here, which is correct *only* because the
--                    table is empty. As a rule of thumb an ordinary btree build
--                    runs at low-millions of rows per minute on one core; on a
--                    populated `sla_timers` these two statements would be
--                    `CREATE INDEX CONCURRENTLY` in their own migration, outside
--                    a transaction, and the `ALTER TABLE` would ship separately
--                    from them.
--                  * The backfill is one `INSERT ... SELECT` over `tenants`, at
--                    one row per tenant. At the low hundreds of tenants 0002
--                    targets that is a single-digit-millisecond statement; it
--                    would only need batching at a tenant count this product
--                    does not have.
--
--   Locks        ACCESS EXCLUSIVE on `sla_timers`, held to commit — the ALTER
--                and both non-concurrent index builds. ACCESS EXCLUSIVE on the
--                new `sla_alerts`, which nothing else can be holding. A
--                ROW EXCLUSIVE on `sla_policies` for the backfill insert, plus
--                two momentary ACCESS EXCLUSIVEs on it from the FORCE RLS toggle
--                described below. `tenants` is only read.
--
--   Blocking     `lock_timeout` caps the wait at three seconds, so a conflicting
--                long-running transaction aborts this migration cleanly rather
--                than queueing ahead of every new query on the table it holds.
--                Re-run once it clears. Nothing reads or writes `sla_timers` or
--                `sla_policies` in the application today, so on the current
--                system the practical blocking risk is nil.
--
--   Data loss    None. Nothing is dropped, no column is narrowed, and the
--                backfill only inserts where no policy row exists.
--
--   Rollback     `down.sql` beside this file. Reversible with no data loss on
--                the empty tables this is applied to; see its header for the one
--                thing it deliberately leaves behind.
--
-- ---------------------------------------------------------------------------
-- Additive and re-runnable
-- ---------------------------------------------------------------------------
--
-- Nothing is dropped, renamed or retyped. Prisma runs a migration in one
-- transaction and records it in `_prisma_migrations`, so a re-run is a no-op at
-- the runner level; the backfill is additionally guarded by `NOT EXISTS`, so it
-- converges rather than duplicating if it is ever replayed by hand.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Precondition, before the statements that depend on it.
-- ---------------------------------------------------------------------------
--
-- The claim above — that the index builds are free because `sla_timers` is
-- empty — is asserted rather than believed. If it ever fires, the fix is to ship
-- the two `CREATE INDEX` statements as `CREATE INDEX CONCURRENTLY` in their own
-- migration directory, outside a transaction, and keep the `ALTER TABLE` here.
--
-- The FORCE ROW LEVEL SECURITY toggle is the same manoeuvre TAR-52, TAR-92 and
-- TAR-20e use: the migration owner is not exempt from FORCE, and no
-- `app.tenant_id` GUC is set here, so `tenant_isolation` matches nothing and a
-- plain count would report 0 on a table full of rows — turning this guard into a
-- rubber stamp.
--
-- Safe inline: DDL is transactional in PostgreSQL, the ALTER below takes ACCESS
-- EXCLUSIVE on the same table moments later, and an abort rolls the toggle back
-- with everything else.
DO $$
DECLARE
    existing bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."sla_timers" NO FORCE ROW LEVEL SECURITY';

    SELECT count(*) INTO existing FROM "public"."sla_timers";

    EXECUTE 'ALTER TABLE "public"."sla_timers" FORCE ROW LEVEL SECURITY';

    IF existing > 0 THEN
        RAISE EXCEPTION
            'sla_timers holds % row(s). This migration builds two indexes on it '
            'non-concurrently, which is only free on an empty table. Split the '
            'CREATE INDEX statements into their own migration as CREATE INDEX '
            'CONCURRENTLY (outside a transaction) before applying this one.', existing;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Schema change. Generated by `prisma migrate diff`, read before committing.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "sla_timers" ADD COLUMN     "breached_at" TIMESTAMPTZ(3),
ADD COLUMN     "paused_at" TIMESTAMPTZ(3),
ADD COLUMN     "paused_ms" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "sla_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sla_timer_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "kind" "sla_target_kind" NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(3),

    CONSTRAINT "sla_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sla_alerts_tenant_id_recipient_user_id_created_at_id_idx" ON "sla_alerts"("tenant_id", "recipient_user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "sla_alerts_tenant_id_ticket_id_idx" ON "sla_alerts"("tenant_id", "ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_alerts_tenant_id_sla_timer_id_recipient_user_id_key" ON "sla_alerts"("tenant_id", "sla_timer_id", "recipient_user_id");

-- CreateIndex
-- Phase 1 of the breach sweep. The one composite index in this schema that does
-- not lead with `tenant_id`, and 0002's rule 3 is knowingly excepted here rather
-- than overlooked: the sweep runs inside a queue worker where no request context
-- exists, so its predicate carries no tenant term at all
-- (`state = 'running' AND due_at <= now()`) and the existing
-- `(tenant_id, state, due_at)` would leave the planner a full scan. It serves a
-- read of two uuid columns; every write the sweep then performs is grouped by
-- tenant and runs under RLS. Same shape of named, single-query exception as
-- `webhook_events` being the one table without a policy.
CREATE INDEX "sla_timers_state_due_at_idx" ON "sla_timers"("state", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "sla_timers_tenant_id_id_key" ON "sla_timers"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "sla_alerts" ADD CONSTRAINT "sla_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_alerts" ADD CONSTRAINT "sla_alerts_tenant_id_sla_timer_id_fkey" FOREIGN KEY ("tenant_id", "sla_timer_id") REFERENCES "sla_timers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_alerts" ADD CONSTRAINT "sla_alerts_tenant_id_ticket_id_fkey" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_alerts" ADD CONSTRAINT "sla_alerts_tenant_id_recipient_user_id_fkey" FOREIGN KEY ("tenant_id", "recipient_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Row-level security for the new table. Hand-written: Prisma's schema language
-- cannot express a policy, so `migrate diff` produces nothing for this and will
-- never propose to drop it either.
--
-- Same predicate as every other scoped table
-- (20260810140000_tenant_isolation_rls), and the same reason for FORCE: ENABLE
-- alone exempts the table owner, and migrations run as the owner.
--
-- `system_unrestricted` — SystemPrisma's second policy — and the table grants
-- are not here. Both are role-dependent, and roles are cluster-scoped:
-- `prisma/sql/app-roles.sql` derives them from the catalogue and is documented
-- to be re-run after any migration that adds a table.
-- `prisma/sql/verify-tenant-isolation.sql` fails by name until it has been, and
-- now carries a two-tenant fixture row in `sla_alerts` as well.
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."sla_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sla_alerts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."sla_alerts"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Backfill: the default SLA policy, for tenants that already exist
-- ---------------------------------------------------------------------------
--
-- 0006 decision 6: the per-tenant SLA configuration *is* an `sla_policies` row,
-- not a column on `tenant_settings`. The platform default is a seed value —
-- TAR-26's stated assumption, "first response within 1 hour" — and a tenant
-- changes its window by editing this row through
-- `PATCH /api/v1/sla-policies/{id}`, or turns SLA off with `is_active = false`.
--
-- `priority` is NULL, meaning "any priority": it is the catch-all that policy
-- resolution falls back to after looking for a policy matching the ticket's own
-- priority. `resolution_minutes` stays NULL, so only the first-response timer
-- exists at v1 (0006, non-goals). `business_hours_only` keeps its `false`
-- default and stays there — risk 1 in that document.
--
-- 60 minutes is stated here, in `TenantProvisioningService` and in the demo
-- dataset. Three statements of one number is the cost of the seed living at
-- three layers; TAR-280 publishes `SLA_DEFAULTS` in
-- `packages/contracts/src/sla.ts` and the two TypeScript sites then import it.
-- This one cannot, and says so.
--
-- Guarded by `NOT EXISTS` rather than `ON CONFLICT`: the unique key is
-- `(tenant_id, name)`, so a tenant that somehow already holds a policy under a
-- *different* name has deliberately configured one and must not be given a
-- second. The guard is "has this tenant any policy at all", which is the same
-- question `SlaPolicyService`'s lazy creation asks (0006, decision 6).
--
-- Ids are supplied rather than defaulted: `schema.prisma` generates UUIDv7 in
-- the Prisma client, and no PostgreSQL release before 18 has a native
-- `uuidv7()`, so there is no column default to fall back on. The expression
-- below lays one out per RFC 9562 §5.7 — 48 bits of Unix milliseconds, the
-- version nibble, then the random tail of a `gen_random_uuid()`, whose variant
-- bits already sit in the right place. A v4 would have worked (nothing sorts
-- `sla_policies` by id), but a v4 among v7s reads as a different kind of row.
--
-- The FORCE RLS toggle again, and for a second reason this time: without it the
-- policy's `WITH CHECK` rejects every row, because no `app.tenant_id` is set
-- during a migration and there is no single tenant this statement could set it
-- to. The insert is still explicitly `tenant_id`-per-row from `tenants`, so it
-- cannot write a row into the wrong tenant.
DO $$
DECLARE
    seeded bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."sla_policies" NO FORCE ROW LEVEL SECURITY';

    INSERT INTO "public"."sla_policies" (
        "id", "tenant_id", "name", "priority",
        "first_response_minutes", "resolution_minutes",
        "business_hours_only", "is_active", "created_at", "updated_at"
    )
    SELECT
        (
            lpad(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0')
            || '7'
            || substr(replace(gen_random_uuid()::text, '-', ''), 14)
        )::uuid,
        t."id",
        'Default',
        NULL,
        60,
        NULL,
        false,
        true,
        now(),
        now()
    FROM "public"."tenants" t
    WHERE NOT EXISTS (
        SELECT 1 FROM "public"."sla_policies" p WHERE p."tenant_id" = t."id"
    );

    GET DIAGNOSTICS seeded = ROW_COUNT;

    EXECUTE 'ALTER TABLE "public"."sla_policies" FORCE ROW LEVEL SECURITY';

    RAISE NOTICE 'seeded the default SLA policy for % existing tenant(s)', seeded;
END
$$;
