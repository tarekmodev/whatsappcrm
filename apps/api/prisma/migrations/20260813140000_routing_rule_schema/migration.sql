-- Make `assignment_rules` able to hold TAR-24's routing rules (TAR-285,
-- implementing the five data-model deltas in
-- `docs/architecture/0007-routing-rules-and-assignment-fallback.md`).
--
-- **No new table.** TAR-47 already shipped `assignment_rules` with
-- `conditions JSONB`, `position`, `is_active` and both target foreign keys,
-- under a comment saying TAR-24 owns the grammar. This migration is the five
-- changes that grammar turned out to need, and nothing else:
--
--   1. `name` becomes `citext`, with `UNIQUE (tenant_id, name)`.
--   2. `CHECK (NOT is_active OR num_nonnulls(target_user_id, target_team_id) = 1)`.
--   3. `action` is dropped.
--   4. The ordering index gains `id`.
--   5. Nothing for row-level security — `assignment_rules` has carried
--      `ENABLE`/`FORCE ROW LEVEL SECURITY` and its `tenant_isolation` policy
--      since `20260810140000_tenant_isolation_rls`, so no `pnpm db:roles`
--      re-run is needed after this and `pnpm db:verify:rls` keeps passing.
--
-- Read 0007 for why each rejected alternative was rejected. This file records
-- only what is being done and what it costs.
--
-- ---------------------------------------------------------------------------
-- 1. `name` becomes `citext`, unique within the tenant
-- ---------------------------------------------------------------------------
--
-- `teams.name` is already `citext` for exactly this reason, and rules inherit
-- it because 0007 puts the rule name into the `ticket_events` row that records
-- why a ticket was routed. Two rules called `Billing` and `billing` are
-- indistinguishable to whoever reads that log, and a supervisor editing the
-- wrong one of a pair changes nothing they can see.
--
-- `citext` also makes the uniqueness case-insensitive, which is the point:
-- `UNIQUE (tenant_id, name)` over plain `text` would still admit both spellings.
--
-- `tenant_id` leads the index (schema conventions, rule 3), so a conflict can
-- never be caused by another tenant's row. A unique index is not RLS-aware;
-- leading with `tenant_id` is what makes that irrelevant here.
--
-- ---------------------------------------------------------------------------
-- 2. An active rule routes to exactly one place
-- ---------------------------------------------------------------------------
--
-- The engine reads the target from these two columns, so a rule with both set
-- has no defined destination and a rule with neither routes into nothing. The
-- API validates it (`RoutingTargetSchema` is a discriminated union, so "exactly
-- one" is unrepresentable-if-wrong on the wire); this is the backstop under
-- anything that writes without going through it.
--
-- **The condition on `is_active` is load-bearing, not defensive.**
-- `users.service.ts` already sets `{ targetUserId: null, isActive: false }` on
-- every rule pointing at a removed user, and its comment says why: "a
-- supervisor should find the rule needing a new target, not find it silently
-- gone". An unconditional `num_nonnulls(...) = 1` would make that shipped
-- statement fail at the constraint and break user removal. The conditional form
-- permits the orphan and still guarantees that anything *evaluated* has
-- somewhere to go. TAR-288 completes it at the API: a `PATCH` setting
-- `isActive: true` on a target-less rule is `validation_failed`, so a
-- supervisor is told what is missing rather than shown a constraint violation.
--
-- Added plain, not `NOT VALID` + `VALIDATE`. The table is empty in every
-- environment this can reach, so the validating scan reads nothing and the
-- two-step buys only a second migration. If this ever has to reach a populated
-- `assignment_rules`, split it: `ADD CONSTRAINT … NOT VALID` (a catalog change,
-- SHARE ROW EXCLUSIVE, instant) then `VALIDATE CONSTRAINT` in its own
-- transaction, which scans under a lock that does not block reads or writes.
--
-- **Prisma cannot express a CHECK constraint** and its describer does not
-- report one, so `schema.prisma` does not contain it and `migrate dev` proposes
-- neither to create nor to drop it — this is not drift. The consequence worth
-- knowing is the same one `tickets_one_active_per_contact` carries: nothing
-- regenerates it from the schema alone. `src/prisma/assignment-rule-schema.int-spec.ts`
-- fails if it is missing.
--
-- ---------------------------------------------------------------------------
-- 3. `action` is dropped — the one destructive statement in this file
-- ---------------------------------------------------------------------------
--
-- The target is the two foreign-key columns; `action` was a second way to say
-- the same thing, with no owner and no published grammar. Nothing in
-- `apps/api`, `apps/web` or `packages/contracts` reads it — the only references
-- to the model anywhere are the removal cleanup above and `schema.prisma`
-- itself — so no data migration precedes this and no code changes with it.
--
-- ⚠️ **`DROP COLUMN` destroys what is in it**, and `down.sql` restores the
-- column but not its contents. That is acceptable here and only here because
-- the column is unread and unwritten in every environment: no seed populates
-- it, no service writes it, and the tenants that exist are fixtures. It is the
-- reason this migration is not purely additive, and it is why the expand →
-- migrate → contract sequence does not apply — there is nothing to expand from
-- and no reader to cut over.
--
-- If a later story needs a non-assignment action ("set priority to urgent"),
-- it comes back as a typed column or a fresh JSONB with a published grammar.
-- That is TAR-27's automation engine, which owns trigger/condition/action
-- properly.
--
-- ---------------------------------------------------------------------------
-- 4. The ordering index gains `id`
-- ---------------------------------------------------------------------------
--
-- The engine's read is `WHERE tenant_id = … AND is_active ORDER BY position ASC,
-- id ASC`, once per created ticket. The tie-break is part of the sort, so it
-- belongs in the index that serves it: without `id`, Postgres can walk the
-- index for the first three columns and still needs a sort step for rows
-- sharing a `position` — and `position` defaults to `0` and is not unique, so
-- two rules created normally share one.
--
-- Replacing rather than adding. `(tenant_id, is_active, position)` is a strict
-- prefix of the new index, so leaving it in place would cost a second index's
-- write and storage to serve queries the new one already serves.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. `assignment_rules` is empty in every environment
--                this can reach, so the type change's table rewrite copies no
--                rows, the CHECK validates nothing and both index builds read
--                nothing.
--   Locks        ACCESS EXCLUSIVE on `assignment_rules` for its whole duration
--                — `ALTER COLUMN … TYPE` rewrites the table and every other
--                statement here is DDL on it. Prisma holds every lock until the
--                last statement commits. Brief locks on `users` and `teams`
--                are not taken: no foreign key is added or altered.
--   Blocking     `lock_timeout` caps the wait at three seconds, so a
--                long-running transaction holding a conflicting lock aborts
--                this migration cleanly instead of queueing ahead of every new
--                query. Re-run once it clears.
--                On a populated table the rewrite would block reads as well as
--                writes for its duration — see the note under 2 for how to
--                split this file if that day comes.
--   Write cost   Unchanged. One index replaces another of the same shape plus a
--                column, and the new unique index is the only net addition —
--                paid on rule writes, which a supervisor makes by hand.
--   Data loss    `assignment_rules.action` and everything in it. See 3.
--   Rollback     `down.sql` beside this file. Structurally exact; it cannot
--                bring `action`'s contents back. See that file.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Guards. Both changes below fail on pre-existing bad data, which is the right
-- failure — but Postgres reports each as a bare violation naming one row. These
-- name the tenant and the count instead, and refuse before anything is altered.
--
-- The migration owner is NOT exempt from FORCE ROW LEVEL SECURITY and no
-- `app.tenant_id` is set here, so a plain count reads zero on a full table —
-- the guard would wave through exactly the case it exists to stop. Counting
-- with the policy suspended is the only reading that means anything. Same idiom
-- and same reasoning as TAR-52's, TAR-74's and TAR-80's guards.
--
-- Safe inline: DDL is transactional, this migration holds ACCESS EXCLUSIVE on
-- `assignment_rules` for its whole duration so no other session can read it
-- while FORCE is off, and an abort — including the RAISEs below — rolls the
-- toggle back with everything else.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    clashing_names bigint;
    targetless_active bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."assignment_rules" NO FORCE ROW LEVEL SECURITY';

    SELECT count(*) INTO clashing_names FROM (
        SELECT "tenant_id", lower("name") AS folded
        FROM "public"."assignment_rules"
        GROUP BY "tenant_id", lower("name")
        HAVING count(*) > 1
    ) AS clashing;

    SELECT count(*) INTO targetless_active
    FROM "public"."assignment_rules"
    WHERE "is_active"
      AND num_nonnulls("target_user_id", "target_team_id") <> 1;

    EXECUTE 'ALTER TABLE "public"."assignment_rules" FORCE ROW LEVEL SECURITY';

    IF clashing_names > 0 THEN
        RAISE EXCEPTION
            'TAR-285 refuses to run: % rule name(s) differ only by case within a tenant',
            clashing_names
            USING HINT =
                'Building assignment_rules_tenant_id_name_key over those rows cannot succeed '
                'once name is citext. List them with SELECT tenant_id, lower(name), count(*) '
                'FROM assignment_rules GROUP BY 1, 2 HAVING count(*) > 1 — then rename the '
                'duplicates in a separate migration and re-run this one. Do not drop the '
                'unique index to make it pass.';
    END IF;

    IF targetless_active > 0 THEN
        RAISE EXCEPTION
            'TAR-285 refuses to run: % active rule(s) do not have exactly one target',
            targetless_active
            USING HINT =
                'An active rule with both targets set has no defined destination, and one '
                'with neither routes nowhere. List them with SELECT id, tenant_id, name FROM '
                'assignment_rules WHERE is_active AND num_nonnulls(target_user_id, '
                'target_team_id) <> 1 — then give each a single target, or deactivate it, '
                'and re-run this one. Do not relax the constraint to make it pass.';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. `name` becomes `citext`, unique within the tenant.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "public"."assignment_rules"
    ALTER COLUMN "name" SET DATA TYPE CITEXT USING "name"::CITEXT;

-- CreateIndex
CREATE UNIQUE INDEX "assignment_rules_tenant_id_name_key"
    ON "public"."assignment_rules" ("tenant_id", "name");

-- ---------------------------------------------------------------------------
-- 2. An active rule routes to exactly one place.
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."assignment_rules"
    ADD CONSTRAINT "assignment_rules_active_has_one_target"
    CHECK (NOT "is_active" OR num_nonnulls("target_user_id", "target_team_id") = 1);

-- ---------------------------------------------------------------------------
-- 3. `action` goes. Destructive; see the header.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "public"."assignment_rules" DROP COLUMN "action";

-- ---------------------------------------------------------------------------
-- 4. The ordering index gains `id`.
-- ---------------------------------------------------------------------------

-- DropIndex
DROP INDEX "public"."assignment_rules_tenant_id_is_active_position_idx";

-- CreateIndex
CREATE INDEX "assignment_rules_tenant_id_is_active_position_id_idx"
    ON "public"."assignment_rules" ("tenant_id", "is_active", "position", "id");
