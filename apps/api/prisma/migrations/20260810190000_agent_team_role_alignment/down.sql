-- Reverses 20260810190000_agent_team_role_alignment.
--
-- Restores the schema exactly as 20260810160000 left it: `owner` back in
-- `user_role`, `teams.name` back to `text`, the four narrower assignment indexes
-- and the two-column `team_members` index back, and the two added columns gone.
--
-- **The one thing that is not reversible** is the data in the two dropped
-- columns. `teams.description` and `users.last_seen_at` are discarded, not
-- archived. That is harmless while they are empty — which is every environment
-- today — and is the reason to run this promptly if it is going to be run at
-- all. Everything else round-trips: no row changes value, and no index the
-- application depends on is missing at any point.
--
-- Re-adding `owner` to the enum is a second type swap rather than an
-- `ALTER TYPE ... ADD VALUE`, because the value has to land in its original
-- ordinal position — first, ahead of `admin` — for the restored type to be
-- byte-for-byte what the initial data model created. `ADD VALUE ... BEFORE`
-- could do it but cannot run inside a transaction block, and this file is one
-- transaction on purpose.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit.
--
-- Locks and duration mirror the up migration: ACCESS EXCLUSIVE on `users`,
-- `invites` and `teams` while they rewrite, SHARE on `conversations` and
-- `tickets` while their indexes rebuild, milliseconds on any current
-- environment. No `pnpm db:roles` re-run: no table, grant or policy changes.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- Indexes back to their pre-TAR-80 shape.
DROP INDEX IF EXISTS "public"."conversations_tenant_assigned_user_inbox_idx";
DROP INDEX IF EXISTS "public"."conversations_tenant_assigned_team_inbox_idx";
DROP INDEX IF EXISTS "public"."tickets_tenant_assigned_user_queue_idx";
DROP INDEX IF EXISTS "public"."tickets_tenant_assigned_team_queue_idx";
DROP INDEX IF EXISTS "public"."team_members_tenant_id_user_id_team_id_idx";

CREATE INDEX IF NOT EXISTS "conversations_tenant_id_assigned_user_id_status_idx" ON "public"."conversations"("tenant_id", "assigned_user_id", "status");
CREATE INDEX IF NOT EXISTS "conversations_tenant_id_assigned_team_id_status_idx" ON "public"."conversations"("tenant_id", "assigned_team_id", "status");
CREATE INDEX IF NOT EXISTS "tickets_tenant_id_assigned_user_id_status_idx" ON "public"."tickets"("tenant_id", "assigned_user_id", "status");
CREATE INDEX IF NOT EXISTS "tickets_tenant_id_assigned_team_id_status_idx" ON "public"."tickets"("tenant_id", "assigned_team_id", "status");
CREATE INDEX IF NOT EXISTS "team_members_tenant_id_user_id_idx" ON "public"."team_members"("tenant_id", "user_id");

-- Columns. Data in both is discarded; see the note above.
ALTER TABLE "public"."users" DROP COLUMN IF EXISTS "last_seen_at";
ALTER TABLE "public"."teams" DROP COLUMN IF EXISTS "description";
ALTER TABLE "public"."teams" ALTER COLUMN "name" SET DATA TYPE TEXT;

-- `user_role` regains `owner`, in its original first position.
CREATE TYPE "public"."user_role_old" AS ENUM ('owner', 'admin', 'supervisor', 'agent');
ALTER TABLE "public"."invites" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "public"."users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "public"."users" ALTER COLUMN "role" TYPE "public"."user_role_old" USING ("role"::text::"public"."user_role_old");
ALTER TABLE "public"."invites" ALTER COLUMN "role" TYPE "public"."user_role_old" USING ("role"::text::"public"."user_role_old");
DROP TYPE "public"."user_role";
ALTER TYPE "public"."user_role_old" RENAME TO "user_role";
ALTER TABLE "public"."invites" ALTER COLUMN "role" SET DEFAULT 'agent';
ALTER TABLE "public"."users" ALTER COLUMN "role" SET DEFAULT 'agent';

COMMIT;
