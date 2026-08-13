-- Give routing somewhere to record what it decided, and a cap on how much work
-- an agent may hold (TAR-272, implementing deltas 1–8 of
-- docs/architecture/0008-assignment-rotation-and-workload.md).
--
-- Five changes, four of them plain `ADD COLUMN`:
--
--   1. Two enums — `ticket_routing_state` and `ticket_routing_deferred_reason`.
--   2. `tickets` gains the routing flag, its reason and when it was raised.
--   3. `users` gains a per-agent workload cap; `tenant_settings` gains the
--      tenant default it inherits from.
--   4. `assignment_state.team_id` becomes nullable so the tenant pool can hold a
--      rotation cursor, with the uniqueness restated as
--      `NULLS NOT DISTINCT`.
--   5. The partial index behind the supervisor's deferred-ticket list, and the
--      CHECKs that keep the three new `tickets` columns agreeing with each other.
--
-- Read 0008 for why each rejected alternative was rejected — a new
-- `ticket_status` value, a `ticket_routing` side table, a synthetic default team.
-- This file records only what is being done and what it costs.
--
-- ---------------------------------------------------------------------------
-- 1. Three departures from 0008's literal SQL, each because the landed schema
--    is not quite what the ADR assumed
-- ---------------------------------------------------------------------------
--
-- **`assignment_state_team_id_key` is an index, not a constraint.** 0008 writes
-- `ALTER TABLE assignment_state DROP CONSTRAINT assignment_state_team_id_key`.
-- Prisma emitted `@unique` as a bare `CREATE UNIQUE INDEX`
-- (20260810130000_initial_data_model, line 814), so there is no constraint of
-- that name and `DROP CONSTRAINT` errors out. `DROP INDEX` is used for both
-- uniques here.
--
-- **The composite unique has to be dropped and recreated, not merely added to.**
-- 0008 lists only the single-column drop, but `assignment_state_tenant_id_team_id_key`
-- already exists as a plain unique index over exactly `(tenant_id, team_id)`.
-- Leaving it in place would keep NULL-distinct semantics on the same column pair
-- the new index is trying to constrain, so the tenant-pool guarantee would be
-- one index away from being silently absent. It is replaced by
-- `assignment_state_tenant_scope_key`, which is the name 0008 gives it and which
-- says what the key means now: a scope is a team **or** the tenant pool.
--
-- **The backfill needs row-level security suspended, or it updates nothing.**
-- 0008's backfill is a bare `UPDATE tickets SET routing_state = 'manual' …`.
-- `tickets` carries `FORCE ROW LEVEL SECURITY`, which does not exempt the table
-- owner, and a migration sets no `app.tenant_id` — so under the deployed role
-- that statement matches zero rows and reports success. Locally it appears to
-- work only because the Compose superuser bypasses RLS entirely, which is the
-- worst way for this to differ: green on a laptop and in CI, a silent no-op on
-- Render. Same `NO FORCE` / `FORCE` idiom, and the same reasoning, as TAR-52's,
-- TAR-74's and TAR-80's guards.
--
-- ---------------------------------------------------------------------------
-- 2. Why the backfill exists at all
-- ---------------------------------------------------------------------------
--
-- The column default makes every existing ticket `pending`, which reads as
-- "routing has not reached a conclusion yet". For a ticket a human already
-- assigned that is false, and the consequence is not cosmetic: `pending` is the
-- state routing is allowed to act on, so the first run of TAR-273's router would
-- treat a supervisor's manual assignment as an unrouted ticket and reassign it.
-- `manual` is terminal for routing, and every already-assigned ticket is by
-- definition a manual one — nothing else has ever written those columns.
--
-- `updated_at` is deliberately not touched. This corrects a classification the
-- ticket always had; it is not an edit, and bumping it would make every ticket
-- in every tenant look freshly modified in a list sorted by it.
--
-- ---------------------------------------------------------------------------
-- 3. What Prisma cannot express here, and therefore never regenerates
-- ---------------------------------------------------------------------------
--
-- Three objects in this file exist only here, exactly as
-- `tickets_one_active_per_contact` (TAR-74) and `users_tenant_id_locked_until_idx`
-- (TAR-53) do:
--
--   * `tickets_routing_deferred_idx` — partial. Prisma's describer skips indexes
--     carrying a predicate, so `migrate dev` proposes neither to create nor to
--     drop it and this is not drift.
--   * The three `CHECK` constraints. Prisma's schema language has no CHECK, and
--     its describer ignores them.
--   * `NULLS NOT DISTINCT` on `assignment_state_tenant_scope_key`. Prisma sees a
--     unique index on `(tenant_id, team_id)` and nothing more, so `@@unique` in
--     `schema.prisma` matches it and there is no drift — **and equally, a future
--     `migrate dev` that recreates the index for any other reason will recreate
--     it NULL-distinct and quietly remove the guarantee.**
--
-- `src/prisma/assignment-workload-schema.int-spec.ts` asserts all three by
-- definition, which is the only thing in the toolchain that would notice.
--
-- ---------------------------------------------------------------------------
-- 4. Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Every `ADD COLUMN` carries a constant default or
--                is nullable, so PostgreSQL 11+ stores it in the catalogue and
--                rewrites no table. `tickets` is empty in every environment this
--                will reach today, so the backfill, both index builds and the
--                three CHECK validations read nothing.
--   Locks        ACCESS EXCLUSIVE on `tickets`, `users`, `tenant_settings` and
--                `assignment_state`, held by Prisma until the last statement
--                commits. On a populated `tickets` the CHECK validation and the
--                index build are the two statements that would hold it for real
--                time; see the note under Scaling below.
--   Blocking     `lock_timeout` caps the wait at three seconds, so a long-running
--                transaction holding a conflicting lock aborts this migration
--                cleanly instead of queueing ahead of every new query. Re-run
--                once it clears.
--   Write cost   One partial index on `tickets`, maintained only for rows in
--                `routing_state = 'deferred'` — a ticket leaves the index when a
--                supervisor picks it up rather than sitting in it. Two CHECKs on
--                `tickets` writes and one on `users`, all constant-time
--                expressions over columns already in the row. No new index on
--                `users`, deliberately: 0008 measures the candidate scan against
--                the existing `(tenant_id, status)` and names the breaking point.
--   Blast radius Additive. Nothing reads or writes any of these columns yet —
--                `routing_state` has no writer until TAR-273 and no reader until
--                TAR-274 — so applying this changes no behaviour at all.
--   Data loss    None in this direction. The `down` is a different matter and
--                says so in its own header.
--   RLS          No new table, so no new policy and no `pnpm db:roles` re-run.
--                A new column inherits its table's `ENABLE`/`FORCE`, its
--                `tenant_isolation` policy and its grants.
--                `verify-tenant-isolation.sql` derives its table list from the
--                catalogue and keeps passing, which here is correct rather than
--                a gap.
--   Rollback     `down.sql` beside this file. Reversible, and destructive in the
--                way that matters — read that file before running it.
--
-- **Scaling, stated because it is not true forever.** Three statements here are
-- safe only because `tickets` is empty: the CHECK validation and the index build
-- both scan it under ACCESS EXCLUSIVE, and the backfill takes a row lock on every
-- assigned ticket. Against a populated table this migration splits into the
-- expand → migrate → contract shape the runbook describes — columns first, then a
-- batched backfill, then `CREATE INDEX CONCURRENTLY` and
-- `ADD CONSTRAINT … NOT VALID` followed by `VALIDATE CONSTRAINT`, each in its own
-- deployable step. `CONCURRENTLY` cannot run inside Prisma's migration
-- transaction at all, so that version is necessarily out-of-band.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The two enums.
-- ---------------------------------------------------------------------------

-- `ticket_routing_deferred_reason` is `FALLBACK_ASSIGNMENT_REASONS` from ADR
-- 0007, verbatim and in order. One vocabulary across the column, the decision
-- object and the `assignment_deferred` event, rather than three that have to be
-- mapped to each other.

-- CreateEnum
CREATE TYPE "ticket_routing_state" AS ENUM ('pending', 'assigned', 'deferred', 'manual');

-- CreateEnum
CREATE TYPE "ticket_routing_deferred_reason" AS ENUM ('all_at_capacity', 'none_available', 'no_candidate_pool');

-- ---------------------------------------------------------------------------
-- 2. `tickets` — the routing flag, its reason, and when it was raised.
-- ---------------------------------------------------------------------------

-- `routing_deferred_since` earns its place as a third column: it is what the
-- supervisor list sorts by (oldest stuck first) and the one value that cannot be
-- recovered afterwards. `created_at` is not a substitute — a ticket assigned,
-- released and then deferred would report an age that is a lie.

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "routing_state" "ticket_routing_state" NOT NULL DEFAULT 'pending',
ADD COLUMN     "routing_deferred_reason" "ticket_routing_deferred_reason",
ADD COLUMN     "routing_deferred_since" TIMESTAMPTZ(3);

-- ---------------------------------------------------------------------------
-- 3. The workload cap — a tenant default, and a per-agent override of it.
-- ---------------------------------------------------------------------------

-- `users.max_concurrent_tickets` is nullable and null means inherit, rather than
-- copying the tenant default onto every user at creation: a supervisor raising
-- the default should move everyone who has not been singled out, and a copied
-- value silently would not. The cost is one `coalesce` in the candidate query.
--
-- The floor is 1, not 0. "Route nothing to me" is what `availability = 'away'`
-- already means, and a second way to say it is a second thing to keep in step.
-- The ceiling is arbitrary but not pointless: it is what stops a fat-fingered
-- 50000 from turning the cap off without anybody noticing. Both bounds are
-- `ASSIGNMENT_POLICY.minMaxConcurrentTickets` / `maxMaxConcurrentTickets`
-- (TAR-273) — the constant and the constraint have to move together.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "max_concurrent_tickets" INTEGER;

-- AlterTable
ALTER TABLE "tenant_settings" ADD COLUMN     "default_max_concurrent_tickets" INTEGER NOT NULL DEFAULT 5;

-- AddCheckConstraint
ALTER TABLE "users" ADD CONSTRAINT "users_max_concurrent_tickets_range" CHECK (
    "max_concurrent_tickets" IS NULL OR "max_concurrent_tickets" BETWEEN 1 AND 1000
);

-- AddCheckConstraint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_default_max_concurrent_tickets_range" CHECK (
    "default_max_concurrent_tickets" BETWEEN 1 AND 1000
);

-- ---------------------------------------------------------------------------
-- 4. Backfill: an already-assigned ticket is a manual one.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    reclassified bigint;
BEGIN
    -- Without this toggle the UPDATE below matches zero rows under the deployed
    -- role and reports success — see departure 3 in the header. Safe inline: DDL
    -- is transactional, this migration already holds ACCESS EXCLUSIVE on
    -- `tickets` for its whole duration so no other session can read the table
    -- while FORCE is off, and an abort rolls the toggle back with everything
    -- else.
    EXECUTE 'ALTER TABLE "public"."tickets" NO FORCE ROW LEVEL SECURITY';

    UPDATE "public"."tickets"
       SET "routing_state" = 'manual'
     WHERE "assigned_user_id" IS NOT NULL
        OR "assigned_team_id" IS NOT NULL;

    GET DIAGNOSTICS reclassified = ROW_COUNT;

    EXECUTE 'ALTER TABLE "public"."tickets" FORCE ROW LEVEL SECURITY';

    -- Zero is the expected reading in every environment this reaches today, and
    -- a non-zero one is not a warning either. It is printed because "the
    -- backfill ran and saw nothing" and "the backfill was filtered out by RLS
    -- and saw nothing" look identical in a deploy log otherwise, and the second
    -- is the failure this block exists to prevent.
    RAISE NOTICE 'TAR-272: % already-assigned ticket(s) set to routing_state = manual', reclassified;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. The flag and its reason cannot disagree.
-- ---------------------------------------------------------------------------

-- Written as an equivalence in both directions on purpose. A partial write that
-- left a ticket `deferred` with no reason renders an empty cell in TAR-274's
-- view; one that left a reason behind on a ticket routing has since assigned
-- renders a stale explanation on a ticket that is fine. Neither fails anywhere
-- else, which is what makes them worth a constraint rather than a code review.
--
-- Both sides are non-nullable booleans — `routing_state` is NOT NULL and
-- `IS NOT NULL` never yields NULL — so this can never pass by evaluating to
-- unknown, which is the usual way a CHECK turns out to be decorative.

-- AddCheckConstraint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_routing_deferred_consistent" CHECK (
    ("routing_state" = 'deferred') = ("routing_deferred_reason" IS NOT NULL) AND
    ("routing_state" = 'deferred') = ("routing_deferred_since" IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 6. The rotation cursor learns about the tenant pool.
-- ---------------------------------------------------------------------------

-- `assignment_state` has never been read or written by anything, so widening
-- `team_id` costs nothing and loses nothing. A tenant with no teams is the
-- ordinary starting state and has to rotate; `NULL` is that tenant's scope.
--
-- **`NULLS NOT DISTINCT` is the whole point of this step and is easy to omit.**
-- PostgreSQL treats NULLs as distinct in a unique index by default, so the plain
-- form would hold five tenant-pool cursors for one tenant quite happily, each
-- read at random. That does not fail — rotation just silently stops rotating,
-- and every ticket goes to whoever sorts first. PostgreSQL 15+; the cluster is
-- pinned to 16 in `docker-compose.yml` and `render.yaml`, which move together.
--
-- The single-column unique on `team_id` is dropped rather than kept. It was
-- redundant with the composite already — team ids are globally unique — and it
-- is outright wrong once the column is nullable, because it would let two
-- tenants' pool cursors coexist only by accident of NULL semantics.

-- AlterTable
ALTER TABLE "assignment_state" ALTER COLUMN "team_id" DROP NOT NULL;

-- DropIndex
DROP INDEX "assignment_state_team_id_key";

-- DropIndex
DROP INDEX "assignment_state_tenant_id_team_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "assignment_state_tenant_scope_key"
    ON "assignment_state" ("tenant_id", "team_id") NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- 7. The supervisor's landing query, and the only index this story adds.
-- ---------------------------------------------------------------------------

-- `GET /tickets?scope=unassigned&routingState=deferred`, sorted oldest-stuck
-- first. Partial, so it holds only the deferred set — small by definition, and
-- if it is not, the tenant has a staffing problem its supervisor can already
-- see. `tenant_id` leads it (schema conventions, rule 3), which is what makes
-- the planner use it at all under a policy that always filters on that column.
--
-- Not CONCURRENTLY, deliberately: Prisma runs a migration inside one transaction
-- and PostgreSQL forbids `CREATE INDEX CONCURRENTLY` there. `tickets` has no
-- rows in any environment this will be applied to, so a plain `CREATE INDEX`
-- takes ACCESS EXCLUSIVE on an empty table for roughly no time and is the
-- correct choice. Reaching a populated `tickets` makes it an out-of-band step —
-- see the Scaling note in the header.

-- CreateIndex
CREATE INDEX "tickets_routing_deferred_idx"
    ON "tickets" ("tenant_id", "routing_deferred_since")
    WHERE "routing_state" = 'deferred';
