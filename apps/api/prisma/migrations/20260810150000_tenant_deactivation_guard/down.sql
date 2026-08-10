-- Reverses 20260810150000_tenant_deactivation_guard.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6). Nothing to
-- generate here in any case — `prisma migrate diff` does not see functions
-- created by hand-written SQL. It is not applied automatically; see the
-- "Rolling a migration back" section of README.md for how to run it and how to
-- correct Prisma's history afterwards.
--
-- ⚠️ ROLL THE APPLICATION BACK FIRST. `TenantPrisma` at the version this
-- migration shipped with calls `assert_tenant_active` around every
-- `set_config('app.tenant_id', ...)`, which is every tenant statement it sends.
-- Drop the function while that code is running and every tenant query fails
-- with `undefined function` — fail-closed, so no data is exposed, but the
-- product is down for every tenant until one side or the other moves.
--
-- No data is touched: the function reads `tenants` and writes nothing. A tenant
-- deactivated while it existed stays `suspended` with its `suspended_at` set,
-- and its data stays where it is — it simply becomes reachable again by the
-- application version that no longer checks.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit.

BEGIN;

DROP FUNCTION IF EXISTS "public"."assert_tenant_active"(text);

COMMIT;
