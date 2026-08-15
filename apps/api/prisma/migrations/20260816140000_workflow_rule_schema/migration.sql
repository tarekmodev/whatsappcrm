-- The workflow rule schema (TAR-394, implementing the data model in
-- `docs/architecture/0009-workflow-triggers-conditions-actions.md`).
--
-- TAR-47 shipped `workflows` and `workflow_runs` as two thin tables under a
-- comment saying TAR-27 owns the grammar. This is that grammar's data model: the
-- deltas those two tables turned out to need, plus the two tables the design adds,
-- and nothing else. The `sla_alerts` → `notifications` rename is a separate,
-- independently landable migration (20260816130000) and nothing here depends on it.
--
-- Read 0009 for why each rejected alternative was rejected. This file records what
-- is being done, what it costs, and the three places it deliberately diverges from
-- that document.
--
-- ---------------------------------------------------------------------------
-- 1. `workflows` — the ordered rule list
-- ---------------------------------------------------------------------------
--
-- A workflow is **one rule**: one trigger, one condition set, one action list
-- (0009, decision 4). Four changes:
--
--   * `name` becomes `citext`. `teams.name` and `assignment_rules.name` already
--     are (conventions, rule 6), and the `UNIQUE (tenant_id, name)` this table has
--     carried since TAR-47 should mean what a reader thinks it means: without it a
--     supervisor creating `escalate` beside an existing `Escalate` gets two rules
--     that look identical in the list, and editing one changes nothing they can
--     see. `tenant_id` leads the index, so a conflict can never be caused by
--     another tenant's row.
--   * `+ position`, the execution order. Not unique — two workflows created
--     normally both hold `0` — which is why the ordering index carries `id` as the
--     tie-break, as 0007 decision 2 established for routing rules.
--   * `+ trigger_type`, a column duplicating a `definition` field **deliberately**.
--     Every triggering occurrence reads "the active workflows in this tenant whose
--     trigger is X", which is the hottest query in the module. A JSONB extraction
--     in that predicate cannot use a composite index that also carries `position`,
--     and an expression index would be a second thing to keep in step with the
--     grammar. TAR-395 writes it in the same statement as `definition`.
--   * `+ broken_reason`, non-null exactly when the workflow was auto-deactivated
--     because a reference broke, behind `workflows_broken_is_inactive`. That CHECK
--     is the API's "fix the reference, then enable" made structural: a broken
--     workflow cannot be active, whatever forgets to check.
--
-- The evaluation index `(tenant_id, is_active, trigger_type, position, id)`
-- **replaces** `(tenant_id, is_active)`, which is a strict prefix of it and would
-- otherwise cost a second index's writes to serve queries the new one serves.
--
-- ---------------------------------------------------------------------------
-- 2. `workflow_runs` — the log and the reservation, in one row
-- ---------------------------------------------------------------------------
--
-- `UNIQUE (tenant_id, workflow_id, dedupe_key)` is **the exactly-once mechanism**
-- (0009, decision 2), not an optimisation over one. The claim is
-- `INSERT … ON CONFLICT (tenant_id, workflow_id, dedupe_key) DO NOTHING RETURNING
-- id`, so the row that records what happened is the row that reserved the right to
-- do it: two replicas, a BullMQ retry and a redelivered job all collapse into one
-- run, by construction rather than by a read-then-write nobody can make atomic.
--
-- The rest of the delta is what makes a run readable after the fact:
-- `ticket_id` (every trigger is about a ticket), `workflow_version` (which
-- definition ran), `results` (per-action outcome), and `failure_reason` typed
-- because a supervisor filters the run list on it and free text cannot be filtered.
-- `error` stays for the human-readable detail behind the reason.
--
-- `(tenant_id, ticket_id, created_at DESC)` answers "what automation touched this
-- ticket" — the first question a supervisor asks, and the only one that starts from
-- the ticket rather than the rule.
--
-- Two CHECKs, and the asymmetry between them is deliberate:
--
--   * `workflow_runs_results_is_array` — `WorkflowRunResponse.results` is an array,
--     and an object here would surface as a validation failure on a *read*, a long
--     way from whatever wrote it.
--   * `workflow_runs_failure_reason_only_when_failed` — a reason only ever appears
--     on a failed run. The other direction (`failed` implies a reason) is **not**
--     constrained: it is true in the executor, where `internal_error` is the
--     catch-all, but making it structural would refuse a legitimate two-statement
--     transition and the cost of the gap is a null a mapper already handles.
--
-- ---------------------------------------------------------------------------
-- 3. `workflow_references` — the reverse index, and the delete that gets refused
-- ---------------------------------------------------------------------------
--
-- One row per entity a workflow's `definition` names, rewritten inside the same
-- transaction as every workflow write (0009, decision 6). It does two things a
-- JSONB scan cannot:
--
--   * "Which workflows reference this tag / team / user?" becomes one indexed read
--     on the taxonomy delete path, rather than a containment scan over every
--     definition in the tenant.
--   * The **database** refuses a delete that would break a workflow. That cannot
--     be a call from `ContactsModule` (L3) into `WorkflowsModule` (L4) — 0002
--     forbids the upward import — but a foreign key is enforced by Postgres and
--     needs no module to know about any other.
--
-- ⚠️ **Divergence 1 from 0009: `NO ACTION`, not `RESTRICT`, on `tag_id` and
-- `team_id`.** 0009 specifies `RESTRICT`; this schema's convention 4 forbids it and
-- names the reason, which applies exactly here. `RESTRICT` is checked the instant
-- the referenced row goes, so the `ON DELETE CASCADE` from `tenants` — which
-- removes a tenant's tags and its `workflow_references` rows inside one statement —
-- would abort or not depending on the order Postgres happened to pick, breaking
-- every fixture, the seed and TAR-403's purge path. `NO ACTION` defers the check to
-- end of statement: a cascading tenant delete succeeds because the referencing rows
-- are gone by then, and a plain `DELETE FROM tags WHERE id = …` still raises
-- `23503` with the constraint name, which is what `ContactsModule` translates into
-- `conflict`. **Both halves of decision 6 hold; only the keyword changes.**
--
-- ⚠️ **Divergence 2: the scope unique index is `NULLS NOT DISTINCT`.** 0009 asks
-- for `UNIQUE (tenant_id, workflow_id, tag_id, team_id, user_id)` so that a
-- workflow naming the same tag from two actions stores one row. As written that
-- constrains **nothing**: every row has exactly two NULLs in the key, and Postgres
-- treats NULL-bearing keys as distinct by default, so the duplicate it exists to
-- prevent inserts cleanly. `NULLS NOT DISTINCT` (Postgres 15+; the stack runs
-- 16.13) is what makes the index mean what the document says. Same trap, same
-- resolution and same reasoning as `assignment_state_tenant_scope_key` (TAR-272) —
-- and the same warning: Prisma matches `@@unique` against this index and reports no
-- drift either way, so a `migrate dev` that recreates it for an unrelated reason
-- recreates it NULL-distinct. `workflow-schema.int-spec.ts` fails when it does.
--
-- The name is explicit (`workflow_references_scope_key`) because Prisma's generated
-- one would be 68 characters and Postgres truncates identifiers at 63 — a silent
-- rename that would make every later diff propose to fix it.
--
-- `num_nonnulls(tag_id, team_id, user_id) = 1` is the other half: a reference row
-- names exactly one entity, so the three partial-looking indexes below are three
-- disjoint lookups rather than one table scanned three ways.
--
-- ---------------------------------------------------------------------------
-- 4. `ticket_tags` — the tag the automation applies
-- ---------------------------------------------------------------------------
--
-- `tags` today are contact tags; TAR-27's own example — "tag `escalated`" — is
-- about the ticket. Mirrors `contact_tags` column for column, against the same
-- taxonomy, with `UNIQUE (tenant_id, ticket_id, tag_id)` so that applying a tag
-- twice is a no-op rather than a failed run, and `(tenant_id, tag_id)` for "every
-- ticket with this tag".
--
-- Tagging the contact instead would have needed no migration at all and is what
-- 0009 rejects: `escalated` is a fact about one incident, a contact tag is a
-- permanent property of a customer, and a workflow writing into the taxonomy
-- TAR-33's segmentation reads would corrupt segments silently and irreversibly.
--
-- ---------------------------------------------------------------------------
-- 5. `tickets_active_created_at_idx` — the elapsed sweep's access path
-- ---------------------------------------------------------------------------
--
-- ⚠️ **Divergence 3 from 0009**, which names `tickets (tenant_id, status,
-- created_at)` as the index phase 1 of the sweep uses. That index does not exist
-- and, built as named, would not serve the query:
--
--   SELECT t.tenant_id, t.id, t.created_at FROM tickets t
--    WHERE t.tenant_id = $tenant AND t.status IN ('open','pending')
--      AND t.created_at <= now() - make_interval(mins => $1)
--    ORDER BY t.created_at LIMIT 50
--
-- `status IN (…)` is two ranges on a column sitting *before* `created_at`, so no
-- single btree scan delivers a `created_at`-ordered stream across both: the planner
-- gets its rows and then sorts the tenant's whole matching set on every tick, which
-- is the cost the `LIMIT 50` exists to avoid. A **partial** index on
-- `(tenant_id, created_at) WHERE status IN ('open','pending')` puts the equality
-- first, the range and the sort key second, and the two-value status filter into
-- the predicate — one bounded probe that stops at the fiftieth row, which is the
-- claim 0009 makes for it. It is also smaller: it holds only active tickets, and a
-- resolved ticket leaves the index instead of sitting in it.
--
-- Same shape and same predicate as `tickets_active_queue_idx` (TAR-284), which is
-- already in this schema; that one leads with `priority` and cannot serve this
-- query.
--
-- **The redundancy question, since `tickets` now carries seven indexes.**
-- `tickets_reporting_metrics_idx` (TAR-427) reached `main` while this branch was
-- open, and it shares this index's exact leading prefix — `(tenant_id,
-- created_at)`. It is not a duplicate of it, in the direction that matters: that
-- index is not partial, so the sweep would walk every ticket in the range with
-- `status` applied as an in-index filter — resolved and closed included — before
-- reaching fifty active ones, and its cost therefore grows with the tenant's
-- *history* rather than with its open backlog. This one contains only active
-- tickets, so the first fifty entries in `created_at` order **are** the answer.
-- Stated the other way round, because it bounds the risk of getting this wrong:
-- the reporting index would still serve the sweep if this one were dropped, so a
-- mistake here costs a slow sweep rather than a broken plan.
--
-- No plan is claimed as measured here — `tickets` holds only seed data in every
-- environment this can reach, so an EXPLAIN against it would prove nothing.
-- TAR-395 logs sweep duration and batch size from its first commit (0009, risk 7),
-- which is where the number comes from.
--
-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------
--
-- Two new tables, so two hand-written RLS blocks — Prisma's schema language cannot
-- express a policy, and `migrate diff` will never propose to drop one.
-- **`pnpm db:roles` must be re-run after this migration**: until it is,
-- `whatsappcrm_app` holds no privilege at all on `workflow_references` or
-- `ticket_tags` and every query against them fails with a permission error rather
-- than returning another tenant's rows (TAR-95). `pnpm db:verify:rls` fails by name
-- until both steps are done, and its fixture now writes a row in each of the four
-- tables this story touches.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. `workflows` and `workflow_runs` are empty in every
--                environment this can reach — no module writes either until
--                TAR-395 — so the `citext` rewrite copies no rows and every CHECK
--                validates nothing. The one index over a populated table is the
--                partial index on `tickets`, which holds seed data only.
--   Locks        ACCESS EXCLUSIVE on `workflows` (the `ALTER COLUMN … TYPE`
--                rewrites it), on `workflow_runs`, and on `tickets` for the
--                duration of the index build. Prisma holds every lock until the
--                last statement commits, so the `tickets` lock spans this whole
--                file — see the note below if that is ever not free.
--                SHARE ROW EXCLUSIVE on `tags`, `teams`, `users` and `tickets`
--                while the new foreign keys are added, which does not block reads.
--   Blocking     `lock_timeout` caps the wait at three seconds, so a long-running
--                transaction holding a conflicting lock aborts this migration
--                cleanly instead of queueing ahead of every new query. Re-run once
--                it clears.
--                ⚠️ On a populated `tickets` the index build blocks reads and
--                writes for its duration. If this ever has to reach a real backlog,
--                split the `CREATE INDEX` out and run it as
--                `CREATE INDEX CONCURRENTLY` outside a transaction — Prisma wraps a
--                migration in one and Postgres forbids the concurrent form there —
--                then check for `indisvalid = false`, because a failed concurrent
--                build leaves an INVALID index that must be dropped and rebuilt.
--                Same note as TAR-284's index, for the same reason.
--   Write cost   Three new indexes on writes nobody makes by hand (`workflow_runs`
--                is written once per claimed occurrence), the three reference
--                lookups on workflow writes only, and one more index on `tickets`
--                maintained on insert and on any update that moves `status` or
--                `created_at`.
--   Data loss    None. Every statement is additive except the replaced index on
--                `workflows`, and no column is dropped.
--   Rollback     `down.sql` beside this file. Structurally exact, and lossless
--                while `workflows` and `workflow_runs` are empty — which is the
--                same condition the guard below asserts on the way in.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Guards. Three columns below are `NOT NULL` with no default, so a non-empty
-- `workflows` or `workflow_runs` would fail this migration — correctly, but as a
-- bare Postgres error naming one column. These name the table and the count, and
-- refuse before anything is altered.
--
-- The migration owner is NOT exempt from FORCE ROW LEVEL SECURITY and no
-- `app.tenant_id` is set here, so a plain count reads zero on a full table — the
-- guard would wave through exactly the case it exists to stop. Counting with the
-- policy suspended is the only reading that means anything. Same idiom and same
-- reasoning as TAR-52's, TAR-74's, TAR-80's and TAR-285's guards.
--
-- Safe inline: DDL is transactional, this migration takes ACCESS EXCLUSIVE on both
-- tables before anything else can read them while FORCE is off, and an abort —
-- including the RAISEs below — rolls the toggle back with everything else.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    existing_workflows bigint;
    existing_runs bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."workflows" NO FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."workflow_runs" NO FORCE ROW LEVEL SECURITY';

    SELECT count(*) INTO existing_workflows FROM "public"."workflows";
    SELECT count(*) INTO existing_runs FROM "public"."workflow_runs";

    EXECUTE 'ALTER TABLE "public"."workflows" FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."workflow_runs" FORCE ROW LEVEL SECURITY';

    IF existing_workflows > 0 THEN
        RAISE EXCEPTION
            'TAR-394 refuses to run: workflows holds % row(s)', existing_workflows
            USING HINT =
                'trigger_type is NOT NULL with no default, because there is no trigger type that '
                'is a safe guess for a rule somebody wrote. No module writes this table before '
                'TAR-395, so rows here were made by hand. Decide what trigger each one carries, '
                'backfill it in a migration that adds the column nullable first, then re-run '
                'this one. Do not give the column a default to make it pass.';
    END IF;

    IF existing_runs > 0 THEN
        RAISE EXCEPTION
            'TAR-394 refuses to run: workflow_runs holds % row(s)', existing_runs
            USING HINT =
                'ticket_id, workflow_version and dedupe_key are all NOT NULL with no default, and '
                'a run row cannot be reconstructed from what the old shape stored — the occurrence '
                'it claimed is exactly what dedupe_key was invented to record. Delete the rows if '
                'they are test data, or keep them by adding the columns nullable in a migration of '
                'their own. Do not invent dedupe keys.';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Enums. Created in this file rather than a separate one: Postgres refuses to use
-- a label in the transaction that *added* it to an existing type, which is not the
-- same as creating a type and using it — that is permitted, and
-- 20260813130000_sla_pause_accounting_and_alerts already relies on it.
-- `workflow_run_status.skipped` is the label that needed its own directory, and it
-- has one (20260816120000).
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "workflow_trigger_type" AS ENUM (
    'ticket_created',
    'ticket_status_changed',
    'ticket_assigned',
    'ticket_sla_breached',
    'ticket_unresolved_for'
);

-- CreateEnum
CREATE TYPE "workflow_broken_reason" AS ENUM ('reference_removed', 'reference_missing');

-- CreateEnum
CREATE TYPE "workflow_failure_reason" AS ENUM (
    'reference_missing',
    'transition_refused',
    'ticket_gone',
    'run_budget_exceeded',
    'internal_error'
);

-- ---------------------------------------------------------------------------
-- 1. `workflows`
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "public"."workflows"
    ALTER COLUMN "name" SET DATA TYPE CITEXT USING "name"::CITEXT;

-- AlterTable
ALTER TABLE "public"."workflows"
    ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "trigger_type" "workflow_trigger_type" NOT NULL,
    ADD COLUMN "broken_reason" "workflow_broken_reason";

ALTER TABLE "public"."workflows"
    ADD CONSTRAINT "workflows_broken_is_inactive"
    CHECK (NOT "is_active" OR "broken_reason" IS NULL);

-- DropIndex
DROP INDEX "public"."workflows_tenant_id_is_active_idx";

-- CreateIndex
CREATE INDEX "workflows_tenant_id_is_active_trigger_type_position_id_idx"
    ON "public"."workflows" ("tenant_id", "is_active", "trigger_type", "position", "id");

-- ---------------------------------------------------------------------------
-- 2. `workflow_runs`
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "public"."workflow_runs"
    ADD COLUMN "ticket_id" UUID NOT NULL,
    ADD COLUMN "workflow_version" INTEGER NOT NULL,
    ADD COLUMN "dedupe_key" TEXT NOT NULL,
    ADD COLUMN "results" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "failure_reason" "workflow_failure_reason";

ALTER TABLE "public"."workflow_runs"
    ADD CONSTRAINT "workflow_runs_results_is_array"
    CHECK (jsonb_typeof("results") = 'array');

ALTER TABLE "public"."workflow_runs"
    ADD CONSTRAINT "workflow_runs_failure_reason_only_when_failed"
    CHECK ("failure_reason" IS NULL OR "status" = 'failed');

-- AddForeignKey
ALTER TABLE "public"."workflow_runs"
    ADD CONSTRAINT "workflow_runs_tenant_id_ticket_id_fkey"
    FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "public"."tickets"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_tenant_id_workflow_id_dedupe_key_key"
    ON "public"."workflow_runs" ("tenant_id", "workflow_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "workflow_runs_tenant_id_ticket_id_created_at_idx"
    ON "public"."workflow_runs" ("tenant_id", "ticket_id", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- 3. `workflow_references`
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "public"."workflow_references" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "tag_id" UUID,
    "team_id" UUID,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_references_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."workflow_references"
    ADD CONSTRAINT "workflow_references_one_target"
    CHECK (num_nonnulls("tag_id", "team_id", "user_id") = 1);

-- CreateIndex
-- NULLS NOT DISTINCT is load-bearing, not tidiness. See the header, divergence 2.
CREATE UNIQUE INDEX "workflow_references_scope_key"
    ON "public"."workflow_references" ("tenant_id", "workflow_id", "tag_id", "team_id", "user_id")
    NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "workflow_references_tenant_id_tag_id_idx"
    ON "public"."workflow_references" ("tenant_id", "tag_id");

-- CreateIndex
CREATE INDEX "workflow_references_tenant_id_team_id_idx"
    ON "public"."workflow_references" ("tenant_id", "team_id");

-- CreateIndex
CREATE INDEX "workflow_references_tenant_id_user_id_idx"
    ON "public"."workflow_references" ("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "public"."workflow_references"
    ADD CONSTRAINT "workflow_references_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."workflow_references"
    ADD CONSTRAINT "workflow_references_tenant_id_workflow_id_fkey"
    FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "public"."workflows"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- `NO ACTION`, not `RESTRICT`. See the header, divergence 1.
ALTER TABLE "public"."workflow_references"
    ADD CONSTRAINT "workflow_references_tenant_id_tag_id_fkey"
    FOREIGN KEY ("tenant_id", "tag_id") REFERENCES "public"."tags"("tenant_id", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."workflow_references"
    ADD CONSTRAINT "workflow_references_tenant_id_team_id_fkey"
    FOREIGN KEY ("tenant_id", "team_id") REFERENCES "public"."teams"("tenant_id", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."workflow_references"
    ADD CONSTRAINT "workflow_references_tenant_id_user_id_fkey"
    FOREIGN KEY ("tenant_id", "user_id") REFERENCES "public"."users"("tenant_id", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 4. `ticket_tags`
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "public"."ticket_tags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_tags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ticket_tags_tenant_id_ticket_id_tag_id_key"
    ON "public"."ticket_tags" ("tenant_id", "ticket_id", "tag_id");

-- CreateIndex
CREATE INDEX "ticket_tags_tenant_id_tag_id_idx"
    ON "public"."ticket_tags" ("tenant_id", "tag_id");

-- AddForeignKey
ALTER TABLE "public"."ticket_tags"
    ADD CONSTRAINT "ticket_tags_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ticket_tags"
    ADD CONSTRAINT "ticket_tags_tenant_id_ticket_id_fkey"
    FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "public"."tickets"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- `Cascade`, unlike `workflow_references.tag_id`: a tag that no longer exists is
-- not a tag on a ticket, and nothing about the ticket breaks when it goes. The
-- delete is refused by the *reference* table when a workflow names the tag, which
-- is where the fixable answer belongs.
ALTER TABLE "public"."ticket_tags"
    ADD CONSTRAINT "ticket_tags_tenant_id_tag_id_fkey"
    FOREIGN KEY ("tenant_id", "tag_id") REFERENCES "public"."tags"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. The elapsed sweep's access path on `tickets`. See the header, divergence 3.
--
-- Prisma cannot express a partial index, so `schema.prisma` does not contain this
-- one; its describer also skips predicated indexes, so `migrate dev` proposes
-- neither to create nor to drop it and its absence is not drift. **Nothing in that
-- file will ever regenerate it** — `workflow-schema.int-spec.ts` is what catches
-- its loss.
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "tickets_active_created_at_idx"
    ON "public"."tickets" ("tenant_id", "created_at")
    WHERE "status" IN ('open', 'pending');

-- ---------------------------------------------------------------------------
-- Row-level security for the two new tables. Hand-written: Prisma's schema
-- language cannot express a policy, so `migrate diff` produces nothing for this
-- and will never propose to drop it either.
--
-- Same predicate as every other scoped table (20260810140000_tenant_isolation_rls),
-- and the same reason for FORCE: ENABLE alone exempts the table owner, and
-- migrations run as the owner.
--
-- `system_unrestricted` — SystemPrisma's second policy — and the table grants are
-- not here. Both are role-dependent, and roles are cluster-scoped:
-- `prisma/sql/app-roles.sql` derives them from the catalogue and is documented to
-- be re-run after any migration that adds a table.
-- `prisma/sql/verify-tenant-isolation.sql` fails by name until it has been, and now
-- carries a two-tenant fixture row in both of these as well.
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."workflow_references" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."workflow_references" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."workflow_references"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "public"."ticket_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ticket_tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."ticket_tags"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Column comments, for whoever meets these tables in psql rather than in
-- `schema.prisma`. The two that are not self-evident, and both are decisions.
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN "public"."workflows"."trigger_type" IS
    'Duplicates the trigger inside definition on purpose: the evaluation read filters on it once '
    'per triggering occurrence, and a JSONB extraction cannot use the composite index that also '
    'carries position. Written in the same statement as definition (TAR-27, ADR 0009).';

COMMENT ON COLUMN "public"."workflow_runs"."dedupe_key" IS
    'The occurrence this run claimed — ticket:{id} for ticket_created and ticket_unresolved_for, '
    'ticket:{id}:event:{ticketEventId} for a status change or assignment, '
    'ticket:{id}:timer:{slaTimerId} for an SLA breach. With workflow_id it is the exactly-once '
    'mechanism, not an optimisation over one (TAR-27, ADR 0009 decision 2).';
