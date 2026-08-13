-- Reverses 20260813150000_ticket_active_queue_index.
--
-- Drops one index and nothing else. No column, no constraint, no data: the up
-- migration was purely additive and this leaves `tickets` exactly as
-- 20260811130000 left it.
--
-- **What it costs.** `GET /api/v1/tickets` still returns correct pages — the
-- order is in the query, not in the index — but every page falls back to a
-- Bitmap Heap Scan plus a top-N Sort over the tenant's whole active set. That
-- is fine at hundreds of active tickets per tenant and is the queue's dominant
-- cost by the low thousands. `ticket-queue-shape.int-spec.ts` fails once this
-- is dropped, which is that spec working rather than an obstacle.
--
-- Nothing else regenerates it: Prisma's schema language has no partial-index
-- syntax and its describer skips predicated indexes, so a re-apply means
-- running `migration.sql` again.
--
-- No `pnpm db:roles` re-run is needed in either direction. An index carries no
-- grants and no policy.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP INDEX IF EXISTS "public"."tickets_active_queue_idx";

COMMIT;
