-- Bound `POST /api/v1/signup/resend` durably, and stop the durable signup
-- counters scanning the whole table (TAR-405, review of #140).
--
-- ---------------------------------------------------------------------------
-- Why a column rather than another Redis window
-- ---------------------------------------------------------------------------
--
-- `SignupThrottleService` counts two things in Redis and two things in
-- `tenant_signups`, and the Redis half fails open by design — an outage must not
-- mean nobody can sign up. The durable half counts rows *created*, which covers
-- `POST /signup` and misses `POST /signup/resend` entirely: a resend writes no
-- new row, so with the cache down that route could mail an unverified address
-- without limit.
--
-- The bound has to live where the resend actually leaves a trace, which is the
-- row it rotates. `resend_count` is that trace. Together with the per-address
-- row count it caps verification mail to one address at
-- `signupsPerEmailPerDay * (1 + resendsPerSignup)` per day with no cache
-- involved at all.
--
-- ---------------------------------------------------------------------------
-- Additive, and safe to re-run
-- ---------------------------------------------------------------------------
--
-- One nullable-or-defaulted column and two indexes; nothing is renamed, dropped
-- or retyped. `IF NOT EXISTS` throughout, so a partly-applied run finishes
-- quietly rather than erroring — the fleet runner may resume mid-way.
--
-- `NOT NULL DEFAULT 0` is safe to add in one statement on PostgreSQL 11+: the
-- default is stored in the catalogue rather than rewritten into every row, so
-- this takes a brief ACCESS EXCLUSIVE lock and no table rewrite. `tenant_signups`
-- is small by construction anyway — rows are consumed or swept.

ALTER TABLE "public"."tenant_signups"
    ADD COLUMN IF NOT EXISTS "resend_count" INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN "public"."tenant_signups"."resend_count" IS
    'How many times this signup''s verification link has been re-sent. Bounded by '
    'SIGNUP_POLICY.resendsPerSignup in application code; the constraint below only '
    'refuses a negative. Durable so the bound survives a Redis outage (TAR-405).';

-- A counter that has gone negative means something decremented it, and nothing
-- should. Cheap to assert, and it fails at the write rather than at the read
-- that later trusts it.
ALTER TABLE "public"."tenant_signups"
    DROP CONSTRAINT IF EXISTS "tenant_signups_resend_count_non_negative";

ALTER TABLE "public"."tenant_signups"
    ADD CONSTRAINT "tenant_signups_resend_count_non_negative"
    CHECK ("resend_count" >= 0);

-- ---------------------------------------------------------------------------
-- The two indexes the durable counters need
-- ---------------------------------------------------------------------------
--
-- Both counts run on **every** signup and resend, not only during an outage —
-- a fallback that engages only when something is broken is one nobody exercises
-- — so without these they are a sequential scan on the hot path of a public
-- endpoint. `created_at DESC` matches the window predicate, which is always
-- `created_at > now() - interval`.
--
-- Not `CONCURRENTLY`: Prisma wraps a migration directory in one transaction and
-- `CREATE INDEX CONCURRENTLY` cannot run inside one. That is the right trade
-- here — the table is small and new, so the brief lock costs nothing. On a large
-- table this would need its own out-of-transaction step.

CREATE INDEX IF NOT EXISTS "tenant_signups_email_created_at_idx"
    ON "public"."tenant_signups" ("email", "created_at" DESC);

-- Partial: a signup with no recorded address contributes nothing to a per-address
-- count, and there is no point carrying those entries.
CREATE INDEX IF NOT EXISTS "tenant_signups_ip_address_created_at_idx"
    ON "public"."tenant_signups" ("ip_address", "created_at" DESC)
    WHERE "ip_address" IS NOT NULL;
