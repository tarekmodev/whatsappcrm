-- Per-tenant onboarding checklist state (TAR-833).
--
-- The persistence half of TAR-832's contract, so that `/onboarding` reads real
-- state instead of the mock transport TAR-830 switched off. One new table, no
-- backfill, and no change to any existing table.
--
-- ---------------------------------------------------------------------------
-- Why one column-free-of-status table, and nothing else
-- ---------------------------------------------------------------------------
--
-- TAR-832 decision 1: **completion is derived on read; only the skip is
-- persisted.** A step is `completed` because the tenant actually has a connected
-- WhatsApp Business Account, an invited agent or edited branding — never because
-- somebody ticked a box — so the only fact the database has to keep is *which
-- steps this tenant chose to put off, and when*.
--
-- That is what makes this migration create-only. A materialised `status` column
-- would need three things this does not:
--
--   1. a reverse hook on every delete path in `whatsapp/`, `identity/` and
--      `tenancy/branding/`, because `OnboardingStepSchema.completedAt` promises
--      to be *"cleared if the underlying fact goes away"* — a tenant that
--      disconnects its WABA must see the step return to `pending`;
--   2. a backfill for every tenant provisioned before this ships, running the
--      same three queries the reader runs anyway;
--   3. a dependency from three unrelated modules onto a checklist service.
--
-- A row's absence here means "not skipped". For a step whose fact is not yet
-- true, that renders as `pending`, which is the correct answer for a tenant that
-- predates this table — hence nothing to backfill.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds, in every environment and at any tenant count.
--                One empty table, one unique index and two foreign keys.
--                Nothing existing is read, rewritten or revalidated.
--
--   Locks        ACCESS EXCLUSIVE on the new table, which no session can be
--                holding because it does not exist yet. SHARE ROW EXCLUSIVE on
--                `tenants` and on `users` for the two foreign keys, taken for
--                the statement only. `lock_timeout` is set below so those two
--                fail fast rather than queueing behind a long transaction —
--                `users` in particular is read on every authenticated request.
--
--   Blocking     Nil in practice at millisecond duration. If a conflicting
--                long-running transaction is open on `users`, this aborts
--                cleanly after 3s and is re-run once it clears; it never
--                queues ahead of live traffic.
--
--   Write cost   One unique index on a table bounded at three rows per tenant
--                (`ONBOARDING_STEP_IDS` has three members and the unique
--                constraint admits one row each). Writes happen when an admin
--                clicks skip or reopen, which is a handful of times per tenant
--                for the lifetime of the tenant.
--
--   Data loss    None. Purely additive — nothing is dropped, renamed or
--                retyped, and there is no backfill.
--
--   Rollback     `down.sql` beside this file. It drops the table, which
--                destroys the skips in it; those are re-creatable by the admin
--                in one click, and nothing else in the schema references them.
--
-- ---------------------------------------------------------------------------
-- After this runs
-- ---------------------------------------------------------------------------
--
-- **`pnpm db:roles` must be re-run**, as after every migration that adds a
-- table. `app-roles.sql` is catalogue-driven — it finds tables by their
-- `tenant_isolation` policy rather than by a list — so it needs no edit, but
-- until it runs this table has no grant for `whatsappcrm_app` and no
-- `system_unrestricted` policy for `whatsappcrm_system`. That order is
-- deliberate (TAR-95): the grant waits for the policy rather than arriving ahead
-- of it, and `pnpm db:verify:rls` phase 1 fails by name if it is skipped.
--
-- Additive and idempotent: every statement is guarded, so applying this to a
-- fresh database, to one at the previous version, or twice in a row all succeed.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
--
-- `id` carries no database default: conventions rule 5 — ids are UUIDv7 minted
-- by the Prisma client, and Postgres 16 has no native `uuidv7()`. Anything
-- inserting outside the client supplies it, which the fixture in
-- `verify-tenant-isolation.sql` does.
--
-- `updated_at` likewise has no default; `@updatedAt` in the schema is the writer.
-- Same shape as `tenant_branding`, `tenant_settings` and `platform_settings`.

CREATE TABLE IF NOT EXISTS "public"."tenant_onboarding_steps" (
    "id" UUID NOT NULL,
    -- Non-null and denormalised even though the tenant is reachable through
    -- `skipped_by_user_id`: an RLS policy is a row predicate and cannot join
    -- (conventions rule 1).
    "tenant_id" UUID NOT NULL,
    -- A member of `ONBOARDING_STEP_IDS` in `@whatsappcrm/contracts`.
    "step_id" TEXT NOT NULL,
    -- NULL means the row survived a `reopen`. See the comment on the column.
    "skipped_at" TIMESTAMPTZ(3),
    "skipped_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_onboarding_steps_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "public"."tenant_onboarding_steps" IS
    'TAR-832 / TAR-833. Which onboarding steps a tenant has chosen to put off. Skips only — '
    'a step is `completed` because the tenant actually has a WABA, an invite or branding, '
    'derived on every read, so there is no status column here and nothing to backfill for '
    'tenants that predate this. A row''s absence means "not skipped".';

COMMENT ON COLUMN "public"."tenant_onboarding_steps"."step_id" IS
    'A member of ONBOARDING_STEP_IDS in @whatsappcrm/contracts. Text rather than an enum '
    'type: adding a fourth step stays INSERT-compatible with no ALTER TYPE and no '
    'rolling-deploy ordering hazard. The value domain is enforced by OnboardingStepIdSchema '
    'at the request boundary, where an unknown id has to produce a 404 anyway.';

COMMENT ON COLUMN "public"."tenant_onboarding_steps"."skipped_at" IS
    'When the admin skipped the step. NULL means the row survived a reopen — the row is kept '
    'rather than deleted so the checklist''s own updatedAt still moves when a step is put '
    'back, and so "was this ever skipped" stays answerable.';

COMMENT ON COLUMN "public"."tenant_onboarding_steps"."skipped_by_user_id" IS
    'Who skipped it. Never on the wire; support-facing only. It is what lets TAR-832 '
    'decision 5 decline to write an audit_logs row for an act with no security or billing '
    'consequence.';

-- ---------------------------------------------------------------------------
-- 2. One index, which is also the concurrency guarantee
-- ---------------------------------------------------------------------------
--
-- Two tabs skipping the same step race into one upsert rather than two rows, and
-- the reader never has to decide which of a pair is authoritative.
--
-- **This is the table's only index, deliberately.** TAR-832 names exactly two
-- access patterns — `(tenant_id)` for the checklist read and
-- `(tenant_id, step_id)` for the skip upsert — and a btree leading with
-- `tenant_id` serves both. A separate `(tenant_id)` index would be a strict
-- prefix of this one: no query could use it that cannot use this, and every
-- write would pay for it. TAR-832's Prisma block carries one; it is omitted
-- here on purpose, and adding it later is a one-line migration.
--
-- No index on `(tenant_id, skipped_by_user_id)` either, unlike `invites`. There
-- it keeps the referential-integrity check on a user delete off a table that
-- grows with the invite history; here the whole table is bounded at three rows
-- per tenant, so that check reads a page or two whatever the tenant count — and
-- removing a user is a status change rather than a delete in the first place
-- (conventions rule 4).
--
-- Built non-concurrently, which is correct only because the table is empty at
-- this instant. It is created in the same transaction as the table it indexes,
-- so there is nothing to scan and nothing to block.

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_onboarding_steps_tenant_id_step_id_key"
    ON "public"."tenant_onboarding_steps"("tenant_id", "step_id");

-- ---------------------------------------------------------------------------
-- 3. Foreign keys
-- ---------------------------------------------------------------------------
--
-- Guarded by a catalogue lookup rather than `IF NOT EXISTS`, which
-- `ADD CONSTRAINT` has no form of.
--
-- `tenant_id → tenants(id)` cascades: a tenant's skips have no meaning without
-- the tenant, and nothing outside the checklist reads them. Note that this
-- cascade is *not* what removes the rows during a hard delete — the purge keeps
-- the `tenants` row as the slug tombstone and deletes each table by name, which
-- is why `PURGE_ORDER` gains this table in the same change.
--
-- `(tenant_id, skipped_by_user_id) → users(tenant_id, id)` is composite,
-- per conventions rule 2: RLS stops a tenant *reading* another tenant's user,
-- and the composite key is what stops one being *referenced* by a handler that
-- took an id from a request. `NO ACTION`, like `invites.invited_by_user_id` and
-- for the same two reasons — `SET NULL` on a composite key would null
-- `tenant_id`, which is `NOT NULL`, and `RESTRICT` is checked immediately and
-- would abort a legitimate cascading delete.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tenant_onboarding_steps_tenant_id_fkey'
          AND conrelid = 'public.tenant_onboarding_steps'::regclass
    ) THEN
        ALTER TABLE "public"."tenant_onboarding_steps"
            ADD CONSTRAINT "tenant_onboarding_steps_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tenant_onboarding_steps_tenant_id_skipped_by_user_id_fkey'
          AND conrelid = 'public.tenant_onboarding_steps'::regclass
    ) THEN
        ALTER TABLE "public"."tenant_onboarding_steps"
            ADD CONSTRAINT "tenant_onboarding_steps_tenant_id_skipped_by_user_id_fkey"
            FOREIGN KEY ("tenant_id", "skipped_by_user_id")
            REFERENCES "public"."users"("tenant_id", "id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Row-level security
-- ---------------------------------------------------------------------------
--
-- The same two lines and the same one policy every tenant-scoped table in the
-- schema carries, and not optional: `TenantOnboardingReader` and
-- `TenantOnboardingService` reach this table through `TENANT_PRISMA`, and
-- without a policy a forgotten `WHERE tenant_id` there would be a cross-tenant
-- read of who put off what rather than a zero-row one.
--
-- `FORCE` includes the table owner, so migrations are not exempt either — which
-- is why any later migration that has to *count* rows here must toggle
-- `NO FORCE` first, the way `20260815120000_branding_and_custom_domains` does.
-- Nothing in this file reads the table, so nothing here needs that.
--
-- `WITH CHECK` makes a cross-tenant write a rejection rather than merely an
-- unreadable row.
--
-- Guarded so a re-run converges: `CREATE POLICY` has no `IF NOT EXISTS`, and
-- `ENABLE`/`FORCE ROW LEVEL SECURITY` are already idempotent.

ALTER TABLE "public"."tenant_onboarding_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."tenant_onboarding_steps" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polname = 'tenant_isolation'
          AND polrelid = 'public.tenant_onboarding_steps'::regclass
    ) THEN
        CREATE POLICY "tenant_isolation" ON "public"."tenant_onboarding_steps"
            USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
END
$$;
