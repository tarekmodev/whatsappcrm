-- The auth schema every backend flow under TAR-35 writes against (TAR-54),
-- implementing the "Data Model" section of
-- `docs/architecture/0005-auth-session-and-invite-contract.md` (TAR-53).
--
-- Five changes, and nothing that is not in that document:
--
--   1. `invites`     + `revoked_at`, `UNIQUE (tenant_id, id)`, and a partial
--                      unique index that makes two live invites for one address
--                      impossible.
--   2. `sessions`    + `absolute_expires_at` (the cap the sliding idle window
--                      may not cross) and `revoked_reason`.
--   3. `users`       + the three durable lockout columns, and a partial index
--                      so an admin can list locked accounts.
--   4. `password_reset_tokens`  new, tenant-scoped, single-use.
--   5. `invite_teams`           new, the teams an invited agent joins.
--
-- **Not** the `user_role` type swap. TAR-53's data model listed it; TAR-80
-- (`f99ba45`, #25) shipped it while that document was in review, so the enum is
-- already `admin | supervisor | agent` and there is nothing to do here.
--
-- ---------------------------------------------------------------------------
-- Nothing reversible is stored in plaintext
-- ---------------------------------------------------------------------------
--
-- `password_reset_tokens.token_hash` holds the SHA-256 hex of a 32-byte random
-- token, exactly as `sessions.token_hash` and `invites.token_hash` already do.
-- The token is never written anywhere — a leak of this database yields no
-- usable reset link, no live session and no acceptable invite. There is no
-- column in this migration that any key can turn back into a credential.
--
-- SHA-256 rather than argon2id is correct *here specifically*: the input is 256
-- bits of uniform entropy, not a human-chosen password, so there is no
-- dictionary for a KDF to slow down — and a KDF on the session hash would tax
-- every authenticated request in the product. Passwords keep argon2id
-- (`users.password_hash`, unchanged by this migration).
--
-- ---------------------------------------------------------------------------
-- The two indexes Prisma cannot express
-- ---------------------------------------------------------------------------
--
-- Both carry a predicate, and Prisma's schema language has no syntax for one.
-- They are therefore raw SQL here and absent from `schema.prisma`, which says
-- so at both sites. Prisma's Postgres describer skips predicated indexes, so
-- `migrate dev` proposes neither to create nor to drop them — this is not
-- drift. The consequence worth knowing: nothing regenerates them from
-- `schema.prisma` alone. Precedent and same arrangement:
-- `tickets_one_active_per_contact` (TAR-74).
--
--   `invites_one_live_per_email`
--       UNIQUE (tenant_id, email) WHERE accepted_at IS NULL
--                                   AND revoked_at IS NULL
--
--   Two live invites for one address means two accounts for one person. The
--   index makes that impossible rather than merely unlikely — a service-level
--   check loses the race between two admins inviting the same person.
--   `email` is `citext`, so `Bob@acme.com` and `bob@acme.com` collide, which is
--   the answer that matches how the address actually behaves.
--
--   **The predicate has no expiry term, and cannot have one.** An expired
--   invite is still `accepted_at IS NULL AND revoked_at IS NULL`, so it still
--   occupies the index, and `AND expires_at > now()` is not available as a fix
--   because Postgres requires an index predicate to be IMMUTABLE. Left
--   unhandled that is a trap: an invite lapses after seven days, the admin's
--   next attempt passes the service check (there is no *live* invite) and then
--   violates the index, and the address becomes un-invitable by any
--   self-service path.
--
--   ⚠️ **TAR-55 must therefore create an invite as an upsert** — reuse the
--   existing unaccepted, unrevoked row (expired or not) with a new
--   `token_hash`, a new `expires_at`, and the role and teams the admin just
--   asked for. 201 when a row was created, 200 when one was reused. This index
--   is safe only with that behaviour on top of it.
--
--   `users_tenant_id_locked_until_idx`
--       (tenant_id, locked_until) WHERE locked_until IS NOT NULL
--
--   "Show me the locked accounts in this tenant" (TAR-59), off an index that
--   contains only the handful of rows that are locked instead of one entry per
--   user. Partial because `locked_until` is NULL for approximately every row,
--   and a full index would be almost entirely dead weight on a column written
--   on every failed login.
--
-- Both lead with `tenant_id` (schema conventions, rule 3). A unique index is
-- not RLS-aware, so leading with `tenant_id` is what makes it impossible for
-- one tenant's invite to collide with another's.
--
-- ---------------------------------------------------------------------------
-- ⚠️ Re-run `pnpm db:roles` after applying this
-- ---------------------------------------------------------------------------
--
-- Two new tables. Since TAR-95 the app role is deliberately excluded from the
-- schema's default privileges, so it holds *no* privilege on a table
-- `app-roles.sql` has not seen — the grant waits for the policy rather than
-- arriving ahead of it. The same run creates their `system_unrestricted`
-- policies, without which `SystemPrisma` reads them as empty.
-- `verify-tenant-isolation.sql` derives its table list from the catalog and
-- fails by name until both are in place; that is the safety net working. CI's
-- Database job already runs the two in that order.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. `users`, `sessions` and `invites` are empty in
--                every environment this will be applied to — no login, invite
--                or reset flow has shipped yet (TAR-55/56/57 are the tasks this
--                unblocks), so every index build reads nothing and the one
--                backfill touches nothing.
--   Locks        ACCESS EXCLUSIVE on `users`, `sessions` and `invites` for
--                their column additions and index builds, and briefly on
--                `tenants`, `users`, `invites` and `teams` for the new foreign
--                keys. Prisma wraps a migration in one transaction, so every
--                lock is held until the last statement commits.
--   Blocking     `lock_timeout` caps the wait at three seconds, so a
--                long-running transaction holding a conflicting lock aborts
--                this migration cleanly instead of queueing ahead of every new
--                query. Re-run once it clears.
--   Write cost   Three new indexes on existing tables, two of them partial and
--                therefore near-empty in normal operation. The unpartial one is
--                `sessions_absolute_expires_at_idx`, maintained on session
--                insert only — the column is written once and never updated,
--                unlike `expires_at`, which the sliding window moves.
--   Data loss    None. Every change is additive.
--   Rollback     `down.sql` beside this file. It drops two tables and five
--                columns and therefore destroys what is in them — read its
--                header before running it.
--
-- ---------------------------------------------------------------------------
-- If this ever has to run against a populated database
-- ---------------------------------------------------------------------------
--
-- It does not today, and the numbers above say so. Three statements would need
-- to change if that stopped being true:
--
--   * The two `CREATE INDEX` statements become out-of-band `CONCURRENTLY`
--     builds — Prisma runs a migration inside one transaction and Postgres
--     forbids `CONCURRENTLY` there.
--   * `ALTER COLUMN absolute_expires_at SET NOT NULL` takes a full-table
--     validating scan under ACCESS EXCLUSIVE. On a large `sessions` the
--     expand → migrate → contract form is: ship the nullable column and the
--     backfill, let the application write it, then add
--     `CHECK (absolute_expires_at IS NOT NULL) NOT VALID`, `VALIDATE
--     CONSTRAINT`, and only then `SET NOT NULL`, which Postgres 12+ takes as
--     proven from the validated check without a second scan.
--   * The backfill becomes a bounded batch loop rather than one `UPDATE`.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Guard. `invites_one_live_per_email` fails on pre-existing duplicates, which
-- is the right failure — but Postgres reports it as a bare unique violation
-- naming one row. This names the count instead, and refuses before anything is
-- altered. Same idiom and same reasoning as TAR-74's and TAR-80's guards.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    duplicate_addresses bigint;
BEGIN
    -- The migration owner is NOT exempt from FORCE ROW LEVEL SECURITY and no
    -- `app.tenant_id` is set here, so a plain count reads zero on a full table
    -- — the guard would wave through exactly the case it exists to stop.
    -- Counting with the policy suspended is the only reading that means
    -- anything.
    --
    -- Safe inline: DDL is transactional, this migration holds ACCESS EXCLUSIVE
    -- on `invites` for its whole duration so no other session can read it while
    -- FORCE is off, and an abort — including the RAISE below — rolls the toggle
    -- back with everything else.
    EXECUTE 'ALTER TABLE "public"."invites" NO FORCE ROW LEVEL SECURITY';

    -- `revoked_at` does not exist yet — it is added below — so the index
    -- predicate's second term is vacuously true for every existing row and
    -- `accepted_at IS NULL` alone is exactly the set the index will cover.
    SELECT count(*) INTO duplicate_addresses FROM (
        SELECT "tenant_id", "email"
        FROM "public"."invites"
        WHERE "accepted_at" IS NULL
        GROUP BY "tenant_id", "email"
        HAVING count(*) > 1
    ) AS clashing;

    EXECUTE 'ALTER TABLE "public"."invites" FORCE ROW LEVEL SECURITY';

    IF duplicate_addresses > 0 THEN
        RAISE EXCEPTION
            'TAR-54 refuses to run: % address(es) already hold more than one unaccepted invite',
            duplicate_addresses
            USING HINT =
                'Building invites_one_live_per_email over those rows cannot succeed. '
                'List them with SELECT tenant_id, email, count(*) FROM invites WHERE '
                'accepted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1 — then keep the '
                'newest per address and delete the rest in a separate migration, and '
                're-run this one. Do not drop the predicate to make it pass.';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. `invites` — revocation, and the composite key `invite_teams` references.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "invites" ADD COLUMN "revoked_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "invites_tenant_id_id_key" ON "invites"("tenant_id", "id");

-- CreateIndex — partial unique, see the header. Not in `schema.prisma`.
CREATE UNIQUE INDEX "invites_one_live_per_email"
    ON "invites" ("tenant_id", "email")
    WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 2. `sessions` — the absolute cap and the revocation reason.
-- ---------------------------------------------------------------------------
--
-- `absolute_expires_at` arrives nullable, is backfilled, and is then made NOT
-- NULL. One `ADD COLUMN ... NOT NULL DEFAULT now() + interval '30 days'` would
-- be shorter and is wrong twice over: the default is volatile, so Postgres
-- rewrites the whole table rather than taking the fast path, and it would leave
-- a default on the column that silently issues a fresh 30-day cap to any insert
-- that forgets to compute one. The cap belongs to the session's creation time,
-- not to the moment a row happens to be written.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "absolute_expires_at" TIMESTAMPTZ(3),
ADD COLUMN "revoked_reason" TEXT;

-- Backfill: `created_at + AUTH_POLICY.sessionAbsoluteMs` (30 days), which is
-- the value the application will write from now on. Empty in every environment
-- today, so this updates nothing; it is here so the statement after it cannot
-- fail on a database where that is not true.
--
-- FORCE is suspended for the same reason as in the guard above: the owner is
-- subject to the policy, no `app.tenant_id` is set, and the UPDATE would
-- otherwise match zero rows on a populated table and leave `SET NOT NULL` to
-- fail with an error that names a constraint rather than the real cause.
DO $$
BEGIN
    EXECUTE 'ALTER TABLE "public"."sessions" NO FORCE ROW LEVEL SECURITY';

    UPDATE "public"."sessions"
    SET "absolute_expires_at" = "created_at" + interval '30 days'
    WHERE "absolute_expires_at" IS NULL;

    EXECUTE 'ALTER TABLE "public"."sessions" FORCE ROW LEVEL SECURITY';
END
$$;

ALTER TABLE "sessions" ALTER COLUMN "absolute_expires_at" SET NOT NULL;

-- CreateIndex — the sweep. A row can be past its absolute cap while its sliding
-- `expires_at` is still in the future, so `sessions_expires_at_idx` does not
-- find it.
CREATE INDEX "sessions_absolute_expires_at_idx" ON "sessions"("absolute_expires_at");

-- ---------------------------------------------------------------------------
-- 3. `users` — durable lockout state (TAR-53, decision 3).
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "users" ADD COLUMN "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_failed_login_at" TIMESTAMPTZ(3),
ADD COLUMN "locked_until" TIMESTAMPTZ(3);

-- CreateIndex — partial, see the header. Not in `schema.prisma`.
CREATE INDEX "users_tenant_id_locked_until_idx"
    ON "users" ("tenant_id", "locked_until")
    WHERE "locked_until" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. `password_reset_tokens`.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "requested_ip" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_tenant_id_user_id_idx" ON "password_reset_tokens"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey — composite, so a `user_id` from another tenant cannot be
-- written even by a handler that took it from a request body (conventions,
-- rule 2).
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. `invite_teams`.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "invite_teams" (
    "tenant_id" UUID NOT NULL,
    "invite_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,

    CONSTRAINT "invite_teams_pkey" PRIMARY KEY ("tenant_id","invite_id","team_id")
);

-- CreateIndex
CREATE INDEX "invite_teams_tenant_id_team_id_idx" ON "invite_teams"("tenant_id", "team_id");

-- AddForeignKey
ALTER TABLE "invite_teams" ADD CONSTRAINT "invite_teams_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_teams" ADD CONSTRAINT "invite_teams_tenant_id_invite_id_fkey" FOREIGN KEY ("tenant_id", "invite_id") REFERENCES "invites"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey — `Cascade` rather than `NoAction`: a team deleted between
-- invite and acceptance takes its pending membership with it, which is the
-- whole reason this is a table and not a `uuid[]` on `invites`.
ALTER TABLE "invite_teams" ADD CONSTRAINT "invite_teams_tenant_id_team_id_fkey" FOREIGN KEY ("tenant_id", "team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. RLS on both new tables. Same predicate, same reasoning, same shape as the
-- other 34 in 20260810140000_tenant_isolation_rls — see that file's header for
-- why it is written this way. Role-agnostic (`TO PUBLIC`), so this applies to a
-- cluster where the application roles do not exist yet.
--
-- This is what closes TAR-54's second acceptance criterion, and it is the only
-- tenant-scoping mechanism in this migration: no second path, no application
-- filter standing in for a policy. With no `app.tenant_id` on the connection,
-- both tables return zero rows.
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."password_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."password_reset_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."password_reset_tokens"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "public"."invite_teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."invite_teams" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."invite_teams"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
