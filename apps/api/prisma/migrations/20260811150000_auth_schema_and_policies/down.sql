-- Reverses 20260811150000_auth_schema_and_policies.
--
-- Restores the schema exactly as 20260811130000 left it: no
-- `password_reset_tokens`, no `invite_teams`, neither of their policies in
-- `pg_policies`, and `users`, `sessions` and `invites` back to the columns and
-- indexes they carried before.
--
-- ---------------------------------------------------------------------------
-- What this destroys, stated plainly
-- ---------------------------------------------------------------------------
--
-- Every change in the up migration is additive, so re-applying it afterwards
-- produces the same schema. The *data* does not come back:
--
--   `password_reset_tokens`   Every outstanding reset link, and the record of
--                             which ones were consumed. Dropping the table is
--                             fail-safe rather than dangerous — an unknown
--                             token is rejected, so every link in flight simply
--                             stops working and the user requests another. The
--                             consumed rows are the loss that matters: they are
--                             what proves a link was single-use, and they are
--                             audit evidence.
--
--   `invite_teams`            The team memberships every pending invite was
--                             going to grant. The invites survive; accepting
--                             one after this lands the agent in no team, and
--                             nothing in the database records what was
--                             intended. Capture it first if any invite is
--                             outstanding:
--
--                               SELECT * FROM invite_teams;
--
--   `invites.revoked_at`      A revoked invite becomes indistinguishable from a
--                             pending one, so a link an admin deliberately
--                             cancelled starts working again. **This is the one
--                             genuinely dangerous consequence of running this
--                             file**, and it is a security regression, not an
--                             inconvenience. If any row has a non-null
--                             `revoked_at`, delete those invites instead of
--                             rolling back:
--
--                               DELETE FROM invites WHERE revoked_at IS NOT NULL;
--
--   `sessions.absolute_expires_at`  The 30-day cap. Sessions revert to the
--                             sliding `expires_at` alone, so one that is used
--                             daily never expires. Live sessions keep working;
--                             the guarantee that a stolen cookie cannot outlive
--                             a month is what is lost.
--
--   `sessions.revoked_reason` Why each session died. Audit annotation only.
--
--   `users.failed_login_attempts` / `last_failed_login_at` / `locked_until`
--                             Every lockout is released, and the counter behind
--                             it reset to zero. An account under an active
--                             brute-force attempt is unlocked by running this.
--
-- No `pnpm db:roles` re-run is needed after this. Dropping the two tables drops
-- their grants and their `system_unrestricted` policies with them, and
-- `verify-tenant-isolation.sql` derives its list from the catalog, so it passes
-- again on its own.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit. `pnpm
-- db:rollback --confirm` is the supported way to run it: it takes an advisory
-- lock and deletes the `_prisma_migrations` row in the same transaction, so the
-- database and Prisma cannot end up disagreeing about what is applied.
--
-- Locks and duration mirror the up migration: ACCESS EXCLUSIVE on `users`,
-- `sessions` and `invites` while their columns drop, milliseconds on any
-- current environment. Dropping a column is a catalog update — Postgres does
-- not rewrite the table — so the size of these tables does not change that.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- The policies go with their tables; dropped explicitly so the intent is
-- visible in the file rather than implied by the DROP TABLE below.
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."invite_teams";
DROP POLICY IF EXISTS "tenant_isolation" ON "public"."password_reset_tokens";

DROP TABLE IF EXISTS "public"."invite_teams";
DROP TABLE IF EXISTS "public"."password_reset_tokens";

-- `users`. The partial index goes with the column it covers, but is dropped
-- explicitly first: `schema.prisma` does not contain it, so nothing else would.
DROP INDEX IF EXISTS "public"."users_tenant_id_locked_until_idx";
ALTER TABLE "public"."users"
    DROP COLUMN IF EXISTS "locked_until",
    DROP COLUMN IF EXISTS "last_failed_login_at",
    DROP COLUMN IF EXISTS "failed_login_attempts";

-- `sessions`.
DROP INDEX IF EXISTS "public"."sessions_absolute_expires_at_idx";
ALTER TABLE "public"."sessions"
    DROP COLUMN IF EXISTS "revoked_reason",
    DROP COLUMN IF EXISTS "absolute_expires_at";

-- `invites`. `invites_one_live_per_email` must be dropped before
-- `revoked_at` — an index predicate depends on the columns it names, and
-- Postgres refuses to drop a column an index references without `CASCADE`.
-- Naming the index is better than reaching for `CASCADE`, which would take
-- anything else that happened to depend on the column too.
DROP INDEX IF EXISTS "public"."invites_one_live_per_email";
DROP INDEX IF EXISTS "public"."invites_tenant_id_id_key";
ALTER TABLE "public"."invites" DROP COLUMN IF EXISTS "revoked_at";

COMMIT;
