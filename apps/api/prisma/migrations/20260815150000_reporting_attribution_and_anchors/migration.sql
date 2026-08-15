-- The rest of ADR 0010's reporting data model: attribution, and a range anchor
-- for the three metrics that are not anchored on `created_at` (TAR-30).
--
-- Purely additive: two nullable columns on `tickets`, two foreign keys, three
-- btree indexes. No column is renamed, retyped, narrowed or dropped, and nothing
-- here reads or moves a row — the backfill is deliberately a separate migration
-- (20260815150100), so a data pass cannot hold the locks this one takes.
--
-- ---------------------------------------------------------------------------
-- What 20260815140000 (TAR-427) already did, and what it left
-- ---------------------------------------------------------------------------
--
-- TAR-427 added `tickets_reporting_metrics_idx` —
-- `(tenant_id, created_at, assigned_user_id, status, first_response_at,
-- resolved_at)` — and measured it: 9 608 buffers down to 214 on 500 000
-- tickets. That index is kept, it is not duplicated here, and it is why this
-- migration adds **no** `(tenant_id, created_at)` of its own: TAR-427's leads
-- with exactly that pair and covers the aggregated columns as well.
--
-- Two things ADR 0010's data model asks for are not in it, and both are here.
--
-- **1. A range anchor per metric.** 0010 decision 2 anchors each metric on the
-- timestamp that makes it true — response time on `first_response_at`,
-- resolution on `resolved_at`, closed-unworked on `closed_at` — because
-- anchoring everything on `created_at` is not reproducible: a ticket created on
-- the last day of a range and resolved a week later would change that range's
-- resolution time after the fact, so a report exported on Monday and re-exported
-- on Friday disagrees with itself.
--
-- `tickets_reporting_metrics_idx` cannot serve those ranges. `first_response_at`
-- sits in position 5 and `resolved_at` in position 6, so neither is reachable as
-- a range start condition without an equality on everything before it — and a
-- report deliberately spans every `status` and every assignee. `closed_at` is
-- not in that index at all. This is the same argument TAR-427 makes against
-- `(tenant_id, status, priority, created_at DESC)`, applied to the other three
-- anchors: without these, those scans cost what the tenant's whole history
-- costs, whatever range was asked for.
--
-- **2. Attribution.** `first_response_user_id` and `resolved_by_user_id`. The
-- per-agent breakdown needs to know who answered and who resolved, and neither
-- is recorded anywhere today — `SlaTimerService` writes the `first_response`
-- event with no actor, deliberately ("the timer observed the reply, it did not
-- make it").
--
-- TAR-427's index carries `assigned_user_id`, which is the attribution 0010
-- decision 4 explicitly rejects: it means "who holds this now", so a ticket
-- reassigned in March moves its January response time onto a different agent's
-- row and a closed period's numbers change after they were reported to a client.
-- The other rejected option — deriving the responder from `messages` at query
-- time — is a second implementation of `stampFirstResponse`'s five-clause
-- definition of "who answered", correct until somebody changes one of them.
--
-- ⚠️ This is a **divergence from what TAR-427 shipped**, not from what TAR-426
-- designed, and it is raised on TAR-428 rather than resolved quietly. If the
-- Architect rules that `assigned_user_id` is the intended attribution after all,
-- the two columns and their backfill come out and the per-agent SQL groups by
-- `assigned_user_id` instead — but 0010 decision 4's reproducibility argument
-- has to be answered first, because the dashboard is client-facing.
--
-- ---------------------------------------------------------------------------
-- The two columns
-- ---------------------------------------------------------------------------
--
-- Nullable, with no default, and that is the contract rather than a
-- convenience. Null means **"not recorded"**: every ticket that predates this
-- migration and every resolution with no actor. The report renders those as its
-- `unattributed` row instead of redistributing them, so the per-agent table
-- still adds up to the summary. A default would manufacture attribution that
-- never happened.
--
-- Nullable also means the rows already in the table stay valid and the code
-- still running does not have to know about them — which is what makes this safe
-- to deploy before the application that writes them.
--
-- Both foreign keys are composite `(tenant_id, <column>) → users (tenant_id,
-- id)` with `ON DELETE NO ACTION`, matching every other user reference in the
-- schema: a user row is never hard-deleted (`status = 'removed'` is the
-- product's delete), and a cascade here would silently erase a closed period's
-- attribution.
--
-- ---------------------------------------------------------------------------
-- The three indexes
-- ---------------------------------------------------------------------------
--
--   (tenant_id, first_response_at)   response-time aggregate and its per-agent grouping
--   (tenant_id, resolved_at)         resolution-time aggregate, resolved volume
--   (tenant_id, closed_at)           closedWithoutResolution only
--
-- Not partial, though `first_response_at IS NOT NULL` would halve two of them:
-- Prisma cannot express an index predicate, and an index created outside
-- `schema.prisma` is drift the next `migrate dev` proposes to drop. Same trade
-- as `sla_timers`, same escalation — out of band, with a spec asserting the
-- definition, once size makes the caveat worth paying.
--
-- Not CONCURRENTLY, for the reason 20260813150000 and 20260815140000 both give:
-- Prisma runs a migration file inside one transaction and Postgres forbids
-- `CREATE INDEX CONCURRENTLY` there. ⚠️ Against a populated fleet these belong
-- in an out-of-band step instead, one statement at a time, outside a
-- transaction, each followed by a check for `indisvalid = false`:
--
--   CREATE INDEX CONCURRENTLY tickets_tenant_id_first_response_at_idx
--     ON tickets (tenant_id, first_response_at);
--   … and the two below it.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds on every current environment; `tickets` holds
--                nothing but seed data. TAR-427 measured 395 ms for one
--                six-column index over 500 000 tickets, so these three narrower
--                ones are the same order — use the CONCURRENTLY path there.
--   Locks        ACCESS EXCLUSIVE on `tickets` for the whole file (Prisma wraps
--                it in one transaction), plus a brief SHARE ROW EXCLUSIVE on
--                `users` for the two foreign keys. `lock_timeout` caps the wait
--                at three seconds so a long-running transaction aborts this
--                cleanly rather than queueing ahead of every new query.
--   Blocking     Reads and writes to `tickets` for the duration.
--   Write cost   Three more btrees maintained on insert and on any update that
--                moves `first_response_at`, `resolved_at` or `closed_at` — on
--                top of the one TAR-427 added, which already costs a write on
--                two of those. Unmeasured, and ADR 0010 risk 4 names the lever
--                if it has to be cut: `(tenant_id, closed_at)` serves the
--                supplementary `closedWithoutResolution` count alone, and
--                dropping that index and that response field together is a
--                coherent reduction. The other two are load-bearing for TAR-30's
--                stated metrics.
--   Data loss    None. Purely additive.
--   Rollback     `down.sql` beside this file. Dropping the columns loses the
--                attribution recorded since deploy — 20260815150100 can
--                reconstruct most of it, within the limits its header states.
--
-- Every statement is guarded (`IF NOT EXISTS`), so re-running this file over a
-- database that already has any part of it succeeds quietly rather than
-- aborting the fleet run half way.

SET LOCAL lock_timeout = '3s';

-- AlterTable
ALTER TABLE "public"."tickets"
    ADD COLUMN IF NOT EXISTS "first_response_user_id" UUID,
    ADD COLUMN IF NOT EXISTS "resolved_by_user_id" UUID;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tickets_tenant_id_first_response_user_id_fkey'
           AND conrelid = 'public.tickets'::regclass
    ) THEN
        ALTER TABLE "public"."tickets"
            ADD CONSTRAINT "tickets_tenant_id_first_response_user_id_fkey"
            FOREIGN KEY ("tenant_id", "first_response_user_id")
            REFERENCES "public"."users"("tenant_id", "id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tickets_tenant_id_resolved_by_user_id_fkey'
           AND conrelid = 'public.tickets'::regclass
    ) THEN
        ALTER TABLE "public"."tickets"
            ADD CONSTRAINT "tickets_tenant_id_resolved_by_user_id_fkey"
            FOREIGN KEY ("tenant_id", "resolved_by_user_id")
            REFERENCES "public"."users"("tenant_id", "id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;
END
$$;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tickets_tenant_id_first_response_at_idx"
    ON "public"."tickets" ("tenant_id", "first_response_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tickets_tenant_id_resolved_at_idx"
    ON "public"."tickets" ("tenant_id", "resolved_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tickets_tenant_id_closed_at_idx"
    ON "public"."tickets" ("tenant_id", "closed_at");
