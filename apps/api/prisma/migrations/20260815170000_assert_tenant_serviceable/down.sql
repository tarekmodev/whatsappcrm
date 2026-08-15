-- Reverses 20260815170000_assert_tenant_serviceable.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- What it destroys
-- ---------------------------------------------------------------------------
--
-- No data. This migration created one function and read nothing.
--
-- ---------------------------------------------------------------------------
-- ⚠️ Ordering: roll the application back first
-- ---------------------------------------------------------------------------
--
-- While step 1 is the only part of the expand → migrate → contract sequence that
-- has landed, nothing calls this function and running this file is inert.
--
-- Once step 2 has shipped — `tenant-scope.extension.ts` calling
-- `assert_tenant_serviceable` — this file takes the gate out from under every
-- tenant request in the product, and the symptom is `42883: function
-- public.assert_tenant_serviceable(text) does not exist` on the first query of
-- every request, not a degraded mode. **Roll the application back to a revision
-- that calls `assert_tenant_active` before running this.**
--
-- That ordering is why step 3 — dropping `assert_tenant_active` — is a separate,
-- later migration: while both functions exist, an application rollback is
-- sufficient on its own and this file is optional.

SET LOCAL lock_timeout = '3s';

DROP FUNCTION IF EXISTS "public"."assert_tenant_serviceable"(text);
