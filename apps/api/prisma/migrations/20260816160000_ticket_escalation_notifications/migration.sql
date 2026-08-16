-- Escalation notifications, and the reference target they need (TAR-468).
--
-- The schema half of TAR-32, built against
-- `docs/architecture/0011-ticket-reassignment-and-escalation.md` and adapted to
-- the table `20260816130000_notifications_generalisation` left behind — see the
-- header of `20260816150000_notification_type_escalation` for why escalation is
-- a `type` value rather than the fourth alerts table 0011 decision 5 specified.
--
-- Four things, and deliberately nothing else:
--
--   1. `ticket_events_tenant_id_id_key` — a composite UNIQUE on
--      `(tenant_id, id)`. The reference target for the foreign key below.
--      `tickets`, `sla_timers` and `workflows` already carry the same constraint
--      for the same reason.
--   2. `notifications.ticket_event_id` — nullable uuid, the `escalation` type's
--      equivalent of `sla_timer_id`.
--   3. The composite foreign key `(tenant_id, ticket_event_id)` and the unique
--      `(tenant_id, ticket_event_id, recipient_user_id)`.
--   4. `notifications_escalation_columns`, the CHECK making "non-null exactly
--      for that type" an invariant rather than a convention — the same shape
--      `notifications_sla_breach_columns` already has one column over.
--
-- ---------------------------------------------------------------------------
-- What this migration deliberately does NOT do
-- ---------------------------------------------------------------------------
--
--   * **No new table.** See the previous migration's header. The API contract is
--     unaffected — `GET /api/v1/escalation-alerts` is a `type = 'escalation'`
--     view over `notifications`, exactly as `sla-alerts` already is.
--
--   * **No `ALTER TABLE tickets`.** 0011 decision 3 rules that escalation raises
--     attention without moving the assignment, and decision 4 that it carries no
--     state on the ticket — no `is_escalated` flag, no `escalated_at`. An
--     escalation is a thing that *happened*, recorded in `ticket_events`; a
--     column would be a second source of truth with no lifecycle to keep it
--     honest, since de-escalation is out of 0011's scope.
--
--   * **No change to `ticket_events`' columns, and no enum for its `type`.**
--     That column is `text` precisely so a story can add a value without a
--     migration. TAR-32 adds `escalated` as a TypeScript constant in
--     `packages/contracts` — TAR-469's work, not DDL. `assigned`/`unassigned`
--     are reused unchanged for reassignment.
--
--   * **No `type` column in any index**, following the reasoning
--     `20260816130000` already recorded for the same table.
--
-- ---------------------------------------------------------------------------
-- The one statement that scales: the UNIQUE index on `ticket_events`
-- ---------------------------------------------------------------------------
--
-- Everything touching `notifications` is metadata-only: one `ADD COLUMN` with no
-- default (PostgreSQL 11+ does not rewrite), one foreign key and one CHECK
-- validated against a table holding at most a handful of seeded rows, and one
-- unique index over the same.
--
-- The `ticket_events` index is the opposite case and is the part of this
-- migration to read before deploying it. Unlike `sla_timers` at TAR-270 or
-- `tickets` at TAR-284, **`ticket_events` is a populated table in any
-- environment that has been used.** Every status change, priority change and
-- routing decision since TAR-25 and TAR-23 has appended to it, and it is
-- append-only — it only grows.
--
-- Two things follow, and they point in opposite directions:
--
--   * **The build cannot fail on a duplicate.** `id` is the primary key, so
--     `(tenant_id, id)` is unique by functional dependency for every possible
--     row. There is no data condition under which this statement errors, which
--     is why no pre-flight duplicate check is written below — there is nothing
--     to check.
--   * **The build takes ACCESS EXCLUSIVE and blocks the table while it runs.**
--     A plain `CREATE INDEX` is the only form available here: Prisma runs each
--     migration file inside one transaction and PostgreSQL forbids
--     `CREATE INDEX CONCURRENTLY` there — the same constraint and the same
--     resolution as `tickets_active_queue_idx` (TAR-284) and
--     `tickets_one_active_per_contact` (TAR-74).
--
-- So the size of `ticket_events` decides whether this is free or a small outage,
-- and it is asserted below rather than assumed. The guard fails with the exact
-- out-of-band statement to run instead.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds on a development or newly provisioned database,
--                where `ticket_events` holds seed data at most. Otherwise it is
--                the btree build: as a rule of thumb, low-millions of rows per
--                minute on one core, so roughly a second per 100 000 events.
--                The guard below refuses above 250 000 rows, where the blocking
--                window stops being something to absorb silently.
--
--   Locks        ACCESS EXCLUSIVE on `ticket_events`, held to commit, for the
--                index build. ACCESS EXCLUSIVE on `notifications` for the column,
--                the constraint and the index — milliseconds. SHARE ROW
--                EXCLUSIVE briefly on `ticket_events` again as the foreign key is
--                validated. Two momentary ACCESS EXCLUSIVEs on `ticket_events`
--                from the FORCE RLS toggle in the guard.
--
--   Blocking     Reads and writes to `ticket_events` for the duration of the
--                index build — which means, in the application, that posting a
--                status change or a routing decision waits. `lock_timeout` caps
--                the *wait* at three seconds, so a conflicting long-running
--                transaction aborts this migration cleanly rather than queueing
--                ahead of every new query on the table. Re-run once it clears.
--
--   Write cost   One more index maintained on every `ticket_events` insert. It is
--                a two-column btree over the primary key and a uuid, and the
--                table is append-only with monotonic UUIDv7 ids, so insertions
--                land at the right-hand edge rather than splitting interior
--                pages. One more unique index on `notifications`, paid on every
--                insert of any type — nulls for the other three, which the btree
--                still stores.
--
--   Data loss    None. Purely additive: nothing is dropped, renamed, narrowed or
--                retyped, no column becomes NOT NULL, and no backfill runs. The
--                new column is null on every existing row, which is correct —
--                none of them is an escalation.
--
--   Blast radius The `notifications` changes are unreachable until TAR-469 ships
--                the routes; the CHECK constrains a column nothing writes yet.
--                The one object that touches shipped behaviour is the
--                `ticket_events` index, and its effect on a correct system is
--                confined to the build window above plus the per-insert cost.
--
--   Rollback     `down.sql` beside this file. Lossless while no `escalation` row
--                exists, which is until TAR-469 ships; see its header for what
--                changes after that.
--
-- ---------------------------------------------------------------------------
-- Additive and re-runnable
-- ---------------------------------------------------------------------------
--
-- Prisma runs a migration in one transaction and records it in
-- `_prisma_migrations`, so a re-run is a no-op at the runner level. The
-- `ticket_events` index is additionally written `IF NOT EXISTS` so that the
-- out-of-band `CONCURRENTLY` path described in the guard converges with this
-- file instead of colliding with it: build it by that name first, and this
-- migration then adds only the `notifications` half.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Precondition, before the statement that depends on it.
-- ---------------------------------------------------------------------------
--
-- The FORCE ROW LEVEL SECURITY toggle is the manoeuvre TAR-52, TAR-92, TAR-20e
-- and TAR-270 use: the migration owner is not exempt from FORCE, and no
-- `app.tenant_id` GUC is set here, so `tenant_isolation` matches nothing and a
-- plain count would report 0 on a table full of rows — turning this guard into a
-- rubber stamp.
--
-- Safe inline: DDL is transactional in PostgreSQL, the index build below takes
-- ACCESS EXCLUSIVE on the same table moments later, and an abort rolls the
-- toggle back with everything else.
--
-- Skipped entirely when the index already exists, so an operator who took the
-- out-of-band path is not blocked by a threshold that no longer applies to them.
DO $$
DECLARE
    existing bigint;
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class
         WHERE relname = 'ticket_events_tenant_id_id_key'
           AND relnamespace = 'public'::regnamespace
    ) THEN
        RAISE NOTICE
            'ticket_events_tenant_id_id_key already exists; skipping the size guard';
        RETURN;
    END IF;

    EXECUTE 'ALTER TABLE "public"."ticket_events" NO FORCE ROW LEVEL SECURITY';

    SELECT count(*) INTO existing FROM "public"."ticket_events";

    EXECUTE 'ALTER TABLE "public"."ticket_events" FORCE ROW LEVEL SECURITY';

    IF existing > 250000 THEN
        RAISE EXCEPTION
            'ticket_events holds % row(s). The UNIQUE index below is a plain '
            'CREATE INDEX taking ACCESS EXCLUSIVE, which at this size blocks '
            'every ticket status change and routing decision for the duration '
            'of the build. Create it out of band first, outside a transaction '
            'and under this exact name, then re-run this migration — it will '
            'find the index and add only the notifications half: '
            'CREATE UNIQUE INDEX CONCURRENTLY ticket_events_tenant_id_id_key '
            'ON public.ticket_events (tenant_id, id); '
            'then verify with SELECT indisvalid FROM pg_index WHERE indexrelid = '
            '''ticket_events_tenant_id_id_key''::regclass — a concurrent build '
            'that fails leaves an INVALID index that must be dropped and '
            'rebuilt rather than retried.', existing;
    END IF;

    RAISE NOTICE
        'ticket_events holds % row(s); building the unique index inline', existing;
END
$$;

-- ---------------------------------------------------------------------------
-- Schema change. Generated by `prisma migrate diff`, read before committing.
--
-- The one edit to the generated output is `IF NOT EXISTS` on the `ticket_events`
-- index, for the convergence reason in the guard above. The resulting catalogue
-- state is identical, so `migrate dev` reports no drift either way.
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_events_tenant_id_id_key" ON "ticket_events"("tenant_id", "id");

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "ticket_event_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_ticket_event_id_recipient_user_id_key" ON "notifications"("tenant_id", "ticket_event_id", "recipient_user_id");

-- ---------------------------------------------------------------------------
-- The composite foreign key. This, not application code, is TAR-468's "tenant
-- scoping enforced at the data layer" (0011, tenant-scoping section).
--
-- Row-level security stops a tenant *reading* another's rows. Only a composite
-- key stops one being *written* against them — which is exactly the path a
-- handler taking an event id from a request body would take if it forgot to
-- scope the lookup. With this, a notification pairing one tenant's escalation
-- with another tenant's row is refused by PostgreSQL, whatever the application
-- believes.
--
-- CASCADE matches `(tenant_id, sla_timer_id)` beside it and buys the invariant
-- 0011 decision 5 wanted: a notification can never reference an escalation that
-- is absent from the audit trail, so "a notification nobody can explain" is not
-- a reachable state.
--
-- Validated instantly: every existing row has `ticket_event_id` null, and a null
-- satisfies a foreign key without a lookup.
-- ---------------------------------------------------------------------------

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_ticket_event_id_fkey" FOREIGN KEY ("tenant_id", "ticket_event_id") REFERENCES "ticket_events"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The CHECK. Hand-written: Prisma's schema language has no CHECK and its
-- describer does not report one, so `migrate diff` produces nothing for this and
-- will never propose to drop it either. `schema.prisma` carries the note, and
-- `escalation-notification-schema.int-spec.ts` fails by name if it goes missing
-- — the same arrangement as `notifications_sla_breach_columns` and
-- `assignment_rules_active_has_one_target`.
--
-- A biconditional in both directions, and each half matters:
--
--   * An `escalation` row with no `ticket_event_id` is a notification with
--     nothing in the audit trail to explain it — the failure the composite key
--     above cannot catch, because a null passes a foreign key.
--   * Any other type carrying one is claiming an escalation that never happened,
--     and would put a workflow notification into the escalation view.
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."notifications"
    ADD CONSTRAINT "notifications_escalation_columns" CHECK (
        ("type" = 'escalation') = ("ticket_event_id" IS NOT NULL)
    );

-- ---------------------------------------------------------------------------
-- No RLS block, and no `pnpm db:roles` re-run — deliberately.
--
-- This migration adds no table. `notifications` already carries `tenant_isolation`
-- and `system_unrestricted`, both attached to the table's OID, and a new column
-- inherits every policy and privilege on it. `verify-tenant-isolation.sql`
-- derives its list from the catalogue, so the count does not move either.
--
-- What does need editing is the by-name half of that script, and this migration
-- lands with it: the fixture now writes an `escalated` `ticket_events` row and an
-- `escalation` notification per tenant, and asserts the composite key refuses a
-- cross-tenant pairing.
-- ---------------------------------------------------------------------------
