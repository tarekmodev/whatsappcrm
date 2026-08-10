-- Agent, team and role schema, aligned to the contract (TAR-80).
--
-- TAR-22 needs three things from the data layer: a role vocabulary the API can
-- actually serialise, somewhere to put a team's description, and indexes that
-- serve the *scoped* reads a non-supervisor makes. The tables themselves —
-- `users`, `teams`, `team_members`, and `tenant_id` on all three — already exist
-- from TAR-47, and TAR-48 already forces the `tenant_isolation` policy on each.
-- Nothing here changes the tenancy mechanism; it closes the gaps between what
-- TAR-39's merged contract promises and what the schema can deliver.
--
-- ---------------------------------------------------------------------------
-- 1. `user_role` loses `owner`
-- ---------------------------------------------------------------------------
--
-- `packages/contracts/src/rbac.ts` defines `TENANT_ROLES` as exactly
-- `agent | supervisor | admin`, and `UserResponseSchema` / `SessionPrincipalSchema`
-- both parse `role` through it. The enum carried a fourth value, `owner`, that
-- no code has ever written or read. Left in place it is a loaded gun: the first
-- row to hold it fails the response interceptor's Zod parse and the endpoint
-- answers 500 rather than returning a user. TAR-22 records "three roles cover
-- v1" as a settled assumption, so the enum moves to the contract rather than the
-- other way round.
--
-- The direction is deliberate. Putting a value back is one
-- `ALTER TYPE ... ADD VALUE` — online, no rewrite. Taking one out is the type
-- swap below, which rewrites every table using the type. Doing it now, while
-- `users` and `invites` are empty, costs nothing; doing it after launch costs a
-- maintenance window.
--
-- ---------------------------------------------------------------------------
-- 2. `teams.description`, and `teams.name` becomes `citext`
-- ---------------------------------------------------------------------------
--
-- `TeamResponseSchema` returns `description`; `TeamCreateInputSchema` accepts it
-- at up to 500 characters. There was no column, so TAR-81 could not have
-- implemented the contract as written. `TEXT`, not `VARCHAR(500)`: the bound is
-- the contract's to enforce, and widening a check constraint later is a lock.
--
-- `name` becomes `citext` because it is half of `UNIQUE (tenant_id, name)` and a
-- human types it. Case-sensitive, an admin can create "billing" alongside an
-- existing "Billing" and get two teams that are indistinguishable in every
-- picker — with conversations routed to one invisible to the members of the
-- other. That is a TAR-22 acceptance criterion failing quietly. Same reasoning
-- as `tenants.slug` and every email column already carry (schema conventions,
-- rule 6).
--
-- ---------------------------------------------------------------------------
-- 3. `users.last_seen_at`
-- ---------------------------------------------------------------------------
--
-- `UserResponse.lastSeenAt` had no column behind it. `users.last_login_at` is
-- not the same fact — an agent who logged in on Monday and is working now was
-- last *seen* now — and the honest source, `sessions.last_seen_at`, is both an
-- aggregate per row of the people list and transient, since expired sessions are
-- swept away. Denormalised onto `users`, written by the same session-touch path
-- that maintains the sessions row (TAR-35), which the principal cache already
-- rate limits to at most one write per user per TTL.
--
-- ---------------------------------------------------------------------------
-- 4. Index sort keys for role-scoped reads
-- ---------------------------------------------------------------------------
--
-- `(tenant_id, assigned_user_id, status)` and its team twin, on both
-- `conversations` and `tickets`, carried the scope but not the order. The reads
-- they exist for are ordered and paginated:
--
--   WHERE tenant_id = <RLS> AND assigned_user_id = :me AND status = 'open'
--   ORDER BY last_message_at DESC, id DESC LIMIT 25
--
-- Measured on 120 000 conversations in one tenant, where the principal holds the
-- 2 000 oldest — a new hire, or a quiet queue beside a busy one:
--
--   before   Index Scan on (tenant_id, status, last_message_at DESC, id DESC),
--            scope demoted to a filter. 3 094 buffers, 39 333
--            `Rows Removed by Filter`, 4.4 ms for one 25-row page. The cost
--            tracks the *tenant's* volume, so it grows for a quiet agent as
--            their busy colleagues work.
--   after    Index Only Scan, 6 buffers, 0.04 ms, no sort node. The cost tracks
--            the principal's own volume, which is what the query asked for.
--
-- On `tickets` the narrower index did apply the scope but re-sorted the whole
-- matching set on every page: 43 buffers against 6 at 500 matching tickets, and
-- that gap widens with the principal's backlog.
--
-- **One thing these indexes do not fix, and TAR-81 needs to know it.** The agent
-- scope is "mine OR my teams'". Written as a single `OR` predicate the planner
-- cannot use either index for the ordering and falls back to the tenant-wide
-- index — measured at 3 094 buffers, i.e. unchanged from `before`. Written as a
-- `UNION ALL` of one branch per scope member, each with its own `ORDER BY` and
-- `LIMIT`, Postgres merge-appends ordered index-only scans: 10 buffers. The
-- index is necessary; it is not sufficient. The query shape is the other half.
--
-- `team_members (tenant_id, user_id)` gains a trailing `team_id`, so resolving
-- `SessionPrincipal.teamIds` on every session bootstrap comes out of the index
-- without a heap fetch. It replaces the narrower index rather than joining it:
-- the old one was a prefix of this one and served nothing extra.
--
-- ---------------------------------------------------------------------------
-- What this migration deliberately does NOT do
-- ---------------------------------------------------------------------------
--
-- No RLS policy changes. `users`, `teams` and `team_members` are already
-- `FORCE ROW LEVEL SECURITY` with `tenant_isolation` (TAR-48), and every foreign
-- key between them is composite `(tenant_id, <parent_id>)`, so a handler that
-- takes a team id from a request body cannot attach a user to another tenant's
-- team even with the policy satisfied. Cross-tenant isolation for this story is
-- already closed at the data layer and this migration does not touch it.
--
-- Role *enforcement within* a tenant — an agent seeing only their own and their
-- teams' conversations — is not enforced by RLS and is not made so here. The
-- policy predicate reads one GUC, `app.tenant_id`, and knows nothing about the
-- caller. Doing it in the database would mean a second GUC carrying the
-- principal and a per-table policy that joins `team_members`, which is a
-- structural change to TAR-39's decision 1 and belongs to the Architect, not to
-- a migration. Until then that half is the `PermissionGuard` and the query
-- scoping in TAR-81.
--
-- No table gains or loses a `tenant_id`, so `pnpm db:roles` does not need
-- re-running: no new table, no new grant, no new policy.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds in every current environment: `users`, `invites`
--                and `teams` are empty, and `conversations` / `tickets` have no
--                rows to index. On a populated database the enum swap and the
--                citext change each rewrite their table — but `users`, `invites`
--                and `teams` are the small tables in this schema (tens of rows
--                per tenant), so this stays a short operation rather than
--                becoming a maintenance window.
--   Locks        ACCESS EXCLUSIVE on `users`, `invites` and `teams` for the
--                rewrites; SHARE on `conversations` and `tickets` while their
--                indexes build. Prisma runs the whole file in one transaction,
--                so every lock is held until the last statement commits.
--   Blocking     `lock_timeout` caps the wait at three seconds, so a conflicting
--                long-running transaction aborts this migration cleanly instead
--                of queueing ahead of every new query. Re-run once it clears.
--   Not CONCURRENTLY   Prisma runs a migration inside a transaction and Postgres
--                forbids `CREATE INDEX CONCURRENTLY` there. Both tables are
--                empty; if that ever stops being true before this ships, the
--                index statements belong in an out-of-band step, not here.
--   Data loss    None. Every change is additive or a widening, except the enum,
--                which the guard below refuses to apply while any row would lose
--                a value.
--   Rollback     `down.sql` beside this file. Fully reversible: it restores
--                `owner`, the narrower indexes, `name` as `text`, and drops the
--                two added columns. Dropping `teams.description` and
--                `users.last_seen_at` discards whatever was written to them,
--                which is the only irreversible part and is empty today.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Guard. Two things would make this migration destructive rather than merely
-- restrictive, and both are checked before anything is altered.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    owner_users   bigint;
    owner_invites bigint;
    name_clashes  bigint;
BEGIN
    -- The migration owner is NOT exempt from FORCE ROW LEVEL SECURITY and no
    -- `app.tenant_id` is set here, so a plain count reads zero on a full table —
    -- the guard would wave through exactly the case it exists to stop. Counting
    -- as the table owner with the policy suspended is the only reading that
    -- means anything. Same idiom, same reasoning as TAR-52's guard.
    --
    -- Safe inline: DDL is transactional, this migration holds ACCESS EXCLUSIVE
    -- on these tables for its whole duration so no other session can read them
    -- while FORCE is off, and an abort — including the RAISE below — rolls the
    -- toggle back with everything else.
    EXECUTE 'ALTER TABLE "public"."users" NO FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."invites" NO FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."teams" NO FORCE ROW LEVEL SECURITY';

    SELECT count(*) INTO owner_users   FROM "public"."users"   WHERE "role" = 'owner';
    SELECT count(*) INTO owner_invites FROM "public"."invites" WHERE "role" = 'owner';

    -- Two teams in one tenant whose names differ only by case survive today and
    -- would collide on the rebuilt unique index the moment `name` is `citext`.
    -- Postgres would report a bare unique violation; this says which rows.
    SELECT count(*) INTO name_clashes FROM (
        SELECT "tenant_id", lower("name")
        FROM "public"."teams"
        GROUP BY "tenant_id", lower("name")
        HAVING count(*) > 1
    ) AS clashing;

    EXECUTE 'ALTER TABLE "public"."users" FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."invites" FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."teams" FORCE ROW LEVEL SECURITY';

    IF owner_users > 0 OR owner_invites > 0 THEN
        RAISE EXCEPTION
            'TAR-80 refuses to run: % user(s) and % invite(s) hold role = ''owner''',
            owner_users, owner_invites
            USING HINT =
                'Removing a value from an enum cannot preserve rows that hold it. Decide '
                'first whether ''owner'' is a real fourth role — if it is, add it to '
                'TENANT_ROLES in packages/contracts/src/rbac.ts and drop this migration '
                'instead. If it is not, re-point those rows at ''admin'' in a separate '
                'migration, then apply this one.';
    END IF;

    IF name_clashes > 0 THEN
        RAISE EXCEPTION
            'TAR-80 refuses to run: % tenant(s) have team names differing only by case',
            name_clashes
            USING HINT =
                'Making teams.name citext rebuilds UNIQUE (tenant_id, name), which those '
                'rows would violate. Merge or rename the duplicates first — SELECT tenant_id, '
                'lower(name), count(*) FROM teams GROUP BY 1, 2 HAVING count(*) > 1 — then '
                're-run.';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. `user_role` loses `owner`
--
-- Generated by `prisma migrate diff`, with its `BEGIN` / `COMMIT` removed:
-- Prisma already runs this file inside one transaction, and a nested `BEGIN`
-- only warns while the matching `COMMIT` would end the *outer* transaction
-- early, leaving everything below it outside the migration's atomicity.
-- ---------------------------------------------------------------------------

-- AlterEnum
CREATE TYPE "user_role_new" AS ENUM ('admin', 'supervisor', 'agent');
ALTER TABLE "public"."invites" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "public"."users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "public"."users" ALTER COLUMN "role" TYPE "user_role_new" USING ("role"::text::"user_role_new");
ALTER TABLE "public"."invites" ALTER COLUMN "role" TYPE "user_role_new" USING ("role"::text::"user_role_new");
ALTER TYPE "public"."user_role" RENAME TO "user_role_old";
ALTER TYPE "public"."user_role_new" RENAME TO "user_role";
DROP TYPE "public"."user_role_old";
ALTER TABLE "public"."invites" ALTER COLUMN "role" SET DEFAULT 'agent';
ALTER TABLE "public"."users" ALTER COLUMN "role" SET DEFAULT 'agent';

-- ---------------------------------------------------------------------------
-- 2 and 3. Columns
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "public"."teams" ADD COLUMN "description" TEXT,
                             ALTER COLUMN "name" SET DATA TYPE CITEXT;

-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN "last_seen_at" TIMESTAMPTZ(3);

-- ---------------------------------------------------------------------------
-- 4. Indexes. Each DROP is superseded by the CREATE that follows it — the old
-- index is a leading-column prefix of the new one, so nothing loses an access
-- path and no read regresses.
-- ---------------------------------------------------------------------------

-- DropIndex
DROP INDEX "public"."conversations_tenant_id_assigned_user_id_status_idx";

-- DropIndex
DROP INDEX "public"."conversations_tenant_id_assigned_team_id_status_idx";

-- DropIndex
DROP INDEX "public"."tickets_tenant_id_assigned_user_id_status_idx";

-- DropIndex
DROP INDEX "public"."tickets_tenant_id_assigned_team_id_status_idx";

-- DropIndex
DROP INDEX "public"."team_members_tenant_id_user_id_idx";

-- CreateIndex
CREATE INDEX "conversations_tenant_assigned_user_inbox_idx" ON "public"."conversations"("tenant_id", "assigned_user_id", "status", "last_message_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "conversations_tenant_assigned_team_inbox_idx" ON "public"."conversations"("tenant_id", "assigned_team_id", "status", "last_message_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "tickets_tenant_assigned_user_queue_idx" ON "public"."tickets"("tenant_id", "assigned_user_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "tickets_tenant_assigned_team_queue_idx" ON "public"."tickets"("tenant_id", "assigned_team_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "team_members_tenant_id_user_id_team_id_idx" ON "public"."team_members"("tenant_id", "user_id", "team_id");
