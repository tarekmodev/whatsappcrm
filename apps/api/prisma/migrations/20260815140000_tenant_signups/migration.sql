-- `tenant_signups` — where a self-signup lives before its tenant exists
-- (TAR-440, for TAR-405).
--
-- ADR 0009 decision 3 fixes the flow: `POST /api/v1/signup` writes one row here
-- and sends one email; nothing is provisioned. `POST /api/v1/signup/verify`
-- consumes that row and only then calls `TenantProvisioningService.provision()`.
-- So between the form and the tenant there has to be somewhere to hold an email
-- address, a password hash, an organisation name, a requested slug, a token
-- digest and an expiry — and neither `invites` nor `password_reset_tokens` can
-- be it. Both are tenant-scoped and RLS-protected, and ADR 0005 amendment 1 puts
-- the tenant in scope from the host *before* authentication, so neither can hold
-- a row for a tenant that does not exist yet.
--
-- TAR-403 shipped `lifecycle_audit_log`, the retention columns, the status
-- vocabulary and `tenant_plan_limits`. This table fell between its scope and
-- TAR-405's; this migration is the whole of it.
--
-- ---------------------------------------------------------------------------
-- Not tenant-scoped, and therefore not RLS-protected
-- ---------------------------------------------------------------------------
--
-- A policy needs a tenant to compare against and there isn't one: at insert the
-- tenant has not been provisioned, and the caller is anonymous. `webhook_events`
-- is the existing precedent and the reasoning is identical — written before the
-- tenant is known, so **the grant, not RLS, is the enforcement**.
--
-- `app-roles.sql` is amended in the same commit to grant `whatsappcrm_app`
-- nothing at all on this table, exactly as it does for `webhook_events`, and
-- `tenant-scope.extension.ts` marks the model `system-only` so a tenant-side
-- call fails with a message that names the cause instead of a bare SQLSTATE
-- 42501 three frames deeper. Signup runs on `SystemPrisma`; ADR 0009 records it
-- as a call site and `@PublicPlatformRoute()` as the posture it wears.
--
-- ---------------------------------------------------------------------------
-- Two deliberate departures from ADR 0009's column sketch
-- ---------------------------------------------------------------------------
--
-- Both are shape, not substance — every column the document lists is here, and
-- nothing about the flow it designs changes. Flagged rather than made quietly,
-- because TAR-405 writes against these names.
--
--   1. **`provisioned_tenant_id`, not `tenant_id`.** The document's own note on
--      that column is "filled on consumption, for forensics" — it is a
--      backreference to the tenant this signup produced, not a scoping key, and
--      the ADR gives it no foreign key for that reason.
--
--      Spelling it `tenant_id` would have a cost the document does not price.
--      `verify-tenant-isolation.sql` phase 1a derives its work from the catalog:
--      *every* table carrying a `tenant_id` column must have FORCEd RLS and a
--      `tenant_isolation` policy, and the one exception, `webhook_events`, is
--      hard-coded. Keeping the name would mean adding a second name to that
--      exception list — weakening the check whose entire value is that it reads
--      the catalog rather than a list, and making a third exception easy. The
--      accurate name keeps the safety net at full strength and needs no
--      exemption. It is also what the column actually is.
--
--   2. **`token_hash TEXT`, not `bytea`.** Every token digest in this schema is
--      SHA-256 hex in a `TEXT` column — `sessions`, `invites`,
--      `password_reset_tokens` — and all three are produced by one idiom,
--      `createHash('sha256').update(token, 'utf8').digest('hex')`
--      (`src/identity/auth-tokens.ts`, `session-token.ts`, `reset-token.ts`).
--      `bytea` would save 32 bytes a row on a table with one row per signup and
--      buy a second hashing path, a `Buffer` in the Prisma client, and a
--      lookup that reads differently from the three beside it. Same digest,
--      same 256 bits of entropy, same guarantee: the token itself is never
--      stored, so a leak of this database yields no usable verification link.
--
-- ---------------------------------------------------------------------------
-- The slug reservation, and why the index cannot carry the expiry
-- ---------------------------------------------------------------------------
--
-- `hostname` on `tenant_domains` is globally unique, so a squatted slug is
-- permanently unavailable to the customer who wanted it. That is why nothing is
-- provisioned before verification — and it creates the problem it solves: the
-- form has to say "that name is taken" *before* the person goes to their inbox,
-- or verification fails at the last step with the one error they cannot fix
-- without starting over.
--
-- So an unconsumed row is a **soft reservation**, held by
-- `tenant_signups_slug_reserved`: unique on `(desired_slug) WHERE consumed_at IS
-- NULL`. A consumed row releases nothing — the tenant holds the slug by then —
-- and an unconsumed one holds it.
--
-- ⚠️ **The predicate has no expiry term, and cannot have one.** An abandoned
-- signup is still `consumed_at IS NULL`, so it still occupies the index, and
-- `AND expires_at > now()` is unavailable because PostgreSQL requires an index
-- predicate to be IMMUTABLE. This is the same trap `invites_one_live_per_email`
-- documents, and it needs the same answer in the application:
--
--     TAR-405's insert path must delete expired unconsumed rows for that slug
--     inside its own transaction before inserting —
--
--         DELETE FROM tenant_signups
--          WHERE desired_slug = $1 AND consumed_at IS NULL AND expires_at <= now();
--
--     — which is what releases the name after `signupTokenTtlMs` and stands in
--     for the predicate the index cannot have. Without it a lapsed signup makes
--     a slug unclaimable by any self-service path. ADR 0009 decision 3 says the
--     same; it is repeated here because this index is safe only with that
--     behaviour on top of it.
--
-- Consumption itself is one conditional statement, the pattern
-- `InviteService.accept` already sets:
--
--     UPDATE tenant_signups
--        SET consumed_at = now()
--      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
--     RETURNING *;
--
-- The update *is* the concurrency control, so two simultaneous uses of one link
-- cannot both win. A read-then-write would let both through, and both would call
-- `provision()`.
--
-- ---------------------------------------------------------------------------
-- Re-run `pnpm db:roles` after applying this
-- ---------------------------------------------------------------------------
--
-- One new table. Since TAR-95 the app role is deliberately excluded from the
-- schema's default privileges, so it holds no privilege on a table
-- `app-roles.sql` has not seen — which is the end state this table wants anyway.
-- What the re-run is actually for is `whatsappcrm_system`, whose grant comes
-- from the same loop; until it runs, `SystemPrisma` cannot reach the table it is
-- the sole reader of. `pnpm db:verify:rls` asserts both halves by name.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. One `CREATE TABLE` and three index builds on a
--                table that does not exist yet, so every build reads nothing.
--                No existing table is altered and there is no backfill.
--   Locks        ACCESS EXCLUSIVE on the new table only, which no other session
--                can see. Nothing tenant-facing queues behind this.
--   Blocking     None. `lock_timeout` is set for consistency with every other
--                migration rather than because there is a lock to wait for.
--   Rewrite      None.
--   Write cost   Three indexes on a table written once per signup attempt.
--   Data loss    None. Purely additive.
--   Rollback     `down.sql` beside this file. It drops the table and therefore
--                everything in it — read its header before running it.
--
-- Nothing here would need to change if it ran against a populated database: the
-- table is new, so `CONCURRENTLY` has nothing to protect and the batched-backfill
-- question does not arise.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------
--
-- `password_hash` before the address is verified is a deliberate call, and ADR
-- 0009 records it: the alternative is collecting the password on the verify
-- page, which makes it a page an attacker who intercepted the link can
-- *complete*, rather than one that only confirms. It is argon2id at the same
-- cost parameters as `users.password_hash`, and an unconsumed row is removed by
-- the expiry sweep, so an abandoned signup leaves no credential behind.
--
-- `timezone` and `locale` are nullable because they are optional on
-- `SignupInputSchema`. Null means "take the `tenant_settings` default" rather
-- than restating `'UTC'` and `'en'` in a second place where they could drift
-- from the first.
--
-- No `updated_at`: the row is written once and consumed once, exactly like
-- `invites` and `password_reset_tokens`, neither of which carries one either.
CREATE TABLE "tenant_signups" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "desired_slug" CITEXT NOT NULL,
    "tenant_name" TEXT NOT NULL,
    "admin_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "timezone" TEXT,
    "locale" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "provisioned_tenant_id" UUID,
    "ip_address" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_signups_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "tenant_signups" IS
    'TAR-440. A self-signup between the form and the tenant existing (ADR 0009 decision 3). '
    'Deliberately not tenant-scoped and carries no RLS policy: at insert there is no tenant to '
    'scope to. The app role is granted nothing on it — the grant, not RLS, is the enforcement, '
    'as for webhook_events.';

COMMENT ON COLUMN "tenant_signups"."password_hash" IS
    'argon2id, same cost parameters as users.password_hash. Taken at signup so verification is '
    'one click and not a second form, and so an intercepted link cannot be completed by whoever '
    'holds it.';

COMMENT ON COLUMN "tenant_signups"."token_hash" IS
    'SHA-256 hex of a 256-bit random token, as sessions/invites/password_reset_tokens. The token '
    'is never stored, so a leak of this database yields no usable verification link.';

COMMENT ON COLUMN "tenant_signups"."provisioned_tenant_id" IS
    'The tenant this signup produced, written on consumption. Forensics only — never a scoping '
    'key, which is why it is not named tenant_id and carries no foreign key: it must outlive the '
    'tenant''s purge and must not make this table look tenant-scoped to pnpm db:verify:rls.';

COMMENT ON COLUMN "tenant_signups"."ip_address" IS
    'Abuse review only — never a filter, never shown to a user. Rate limiting itself is Redis-'
    'backed, in the shape LoginThrottleService already uses.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- The verify lookup. Named as Prisma names it, because `schema.prisma` declares
-- the column `@unique` and a hand-picked name here would read as drift on the
-- next `migrate dev`.
CREATE UNIQUE INDEX "tenant_signups_token_hash_key" ON "tenant_signups"("token_hash");

-- The soft reservation — see the header for why the predicate cannot carry an
-- expiry term and what TAR-405 must therefore do on insert.
--
-- Partial, so **not in `schema.prisma`**: Prisma's schema language has no syntax
-- for an index predicate and its Postgres describer skips predicated indexes, so
-- `migrate dev` proposes neither to create nor to drop this one. That is not
-- drift — the same arrangement as `invites_one_live_per_email` and
-- `tickets_one_active_per_contact`. The consequence worth knowing: nothing
-- regenerates it from `schema.prisma` alone.
CREATE UNIQUE INDEX "tenant_signups_slug_reserved"
    ON "tenant_signups" ("desired_slug")
    WHERE "consumed_at" IS NULL;

-- The expiry sweep, which runs across every signup under `SystemPrisma` with no
-- tenant term at all:
--
--     DELETE FROM tenant_signups WHERE consumed_at IS NULL AND expires_at <= now();
--
-- Partial on the same predicate, and that is the whole point of it. A consumed
-- row is kept for forensics and its `expires_at` is in the past too, so an
-- unpartial index would hand the sweep every signup ever completed and leave the
-- filter to throw them away — growing with the customer count forever. This one
-- holds only the reservations currently outstanding, which is a handful.
-- `password_reset_tokens_expires_at_idx` is unpartial for its sweep; this is the
-- same query with a longer-lived tail of consumed rows behind it.
--
-- Predicated, so not in `schema.prisma` either.
CREATE INDEX "tenant_signups_expires_at_idx"
    ON "tenant_signups" ("expires_at")
    WHERE "consumed_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

-- The slug becomes a DNS label and then a permanent, globally unique hostname,
-- chosen by an unauthenticated caller. `TenantSlugSchema` is what provisioning
-- accepts — 3 to 40 characters, lowercase letters, digits and hyphens, no
-- leading or trailing hyphen — and a reservation the tenant could never be given
-- is a reservation that squats a name for nothing. Same reasoning as
-- `tenant_plan_limits_plan_key_format`: the shape the contract publishes,
-- restated where the row is written.
--
-- Cast to `text` on purpose. `citext` has no regex operator of its own, so the
-- match is case-*sensitive* — which is what is wanted here, because the schema
-- requires lowercase. The column stays `citext` so `Acme` and `acme` collide on
-- `tenant_signups_slug_reserved` and against `tenants.slug`, which is `citext`
-- too.
--
-- Prisma has no syntax for a CHECK and its describer ignores them, so this lives
-- here and nothing regenerates it from `schema.prisma`.
ALTER TABLE "tenant_signups"
    ADD CONSTRAINT "tenant_signups_desired_slug_format" CHECK (
        "desired_slug"::text ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
    );

-- A tenant recorded here means this signup was consumed. **One way only, and
-- deliberately not a biconditional**: the consuming statement is the conditional
-- `UPDATE … WHERE consumed_at IS NULL RETURNING` above, which has to win the race
-- *before* `provision()` is called and can therefore know the tenant id. So
-- consumed-with-no-tenant-yet is a real intermediate state inside that
-- transaction, and requiring both at once would force the flow to abandon the
-- single-use pattern that makes it safe.
--
-- The direction that is enforced is the one that could lie: a row naming a
-- tenant it never provisioned.
ALTER TABLE "tenant_signups"
    ADD CONSTRAINT "tenant_signups_provisioned_implies_consumed" CHECK (
        "provisioned_tenant_id" IS NULL OR "consumed_at" IS NOT NULL
    );

-- ---------------------------------------------------------------------------
-- No row-level security, stated rather than omitted
-- ---------------------------------------------------------------------------
--
-- Every other table added since TAR-48 ends with an `ENABLE`/`FORCE`/`CREATE
-- POLICY` block. This one ends without one, and the absence is the decision
-- rather than an oversight — see the header. `pnpm db:verify:rls` proves the
-- other half holds: the app role can reach neither this table nor any other
-- unprotected one, and it asserts this table by name.
