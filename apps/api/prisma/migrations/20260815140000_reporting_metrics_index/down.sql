-- Reverses 20260815140000_reporting_metrics_index.
--
-- Drops one index and nothing else. No column, no constraint, no policy, no
-- data: the up migration was purely additive and this leaves `tickets` exactly
-- as 20260813150000 left it.
--
-- **What it costs.** The reporting dashboard and the export still return
-- correct numbers — the aggregation is in the query, not in the index — but
-- every metrics request falls back to a Parallel Seq Scan over the whole
-- `tickets` table: 9 608 buffers against 214, and a cost that no longer depends
-- on the date range the supervisor picked. Measured at 38.5 ms for a 30-day
-- summary over 500 000 tickets; it grows with the fleet's total ticket count,
-- not with the report.
--
-- Unlike the other bespoke indexes on `tickets`, this one **is** declared in
-- `schema.prisma`. Prisma can express it, so `migrate dev` will propose to
-- recreate it and its absence *is* reported as drift — dropping it here without
-- also removing the `@@index` line leaves the schema and the database
-- disagreeing. Reverting the schema change alongside this file is the whole
-- rollback.
--
-- No `pnpm db:roles` re-run is needed in either direction. An index carries no
-- grants and no policy, and tenant isolation does not depend on this one:
-- `tenant_isolation` filters through whatever access path remains.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "public"."tickets_reporting_metrics_idx";

COMMIT;
