-- The `channels` supertype and cross-channel contact identity (TAR-819, ADR 0013).
--
-- This is the **expand** half of expand → migrate → contract. Everything here is
-- additive: two new tables, one new nullable column, one relaxed NOT NULL. No
-- application code reads any of it, every existing write still works unchanged,
-- and rolling the application back over this migration is a no-op.
--
-- ---------------------------------------------------------------------------
-- What it does, and the one property the whole plan rests on
-- ---------------------------------------------------------------------------
--
-- WhatsApp is not *a* channel in this schema today; it is the only shape a
-- conversation can have. `channels` is the supertype every connected endpoint
-- gets a row in — a WhatsApp number now, an Instagram professional account and a
-- Facebook Page later — with provider-specific columns staying on their own
-- table joined on a shared primary key.
--
-- **A `channels` row takes the `whatsapp_accounts.id` that already exists.** So
-- `conversations.channel_id` is a byte-for-byte copy of
-- `conversations.whatsapp_account_id`, not a remap: every id already in a log
-- line, an audit row, a fixture or a support ticket still resolves, and the
-- eventual column swap is a rename with a parent table above it. That property
-- is what keeps TAR-820's refactor bounded, and it is the reason this migration
-- inserts explicit ids rather than generating them.
--
-- The second table, `contact_identities`, is the harder half. `contacts` is
-- keyed on `(tenant_id, phone_e164)` and Instagram has no phone number anywhere
-- in it — identity there is a page-scoped IGSID. Without this indirection a
-- second channel would either invent a fake phone number or fork the contact
-- table, and "the same customer on WhatsApp and Instagram" would become
-- permanently unrepresentable. It makes that representable and nothing more:
-- there is no merge UI, no automatic linking and no dedup heuristic
-- (ADR 0013, open question 3).
--
-- ---------------------------------------------------------------------------
-- What this migration deliberately does NOT do
-- ---------------------------------------------------------------------------
--
-- ADR 0013's migration strategy describes three "independently deployable"
-- steps and puts four changes in step 2. Three of those four are **not**
-- deployable ahead of TAR-820's code change, because each one refuses a write
-- the running application still makes:
--
--   * `conversations.channel_id NOT NULL` — the inbound writer sets
--     `whatsapp_account_id` alone, so the next inbound message from a new
--     contact would fail its insert.
--   * `whatsapp_accounts.id` as a foreign key to `channels.id` — connecting a
--     number writes `whatsapp_accounts` with no `channels` row, so WhatsApp
--     connect would fail on its last step, after the Graph API calls have
--     already succeeded.
--   * dropping `conversations.whatsapp_account_id` and
--     `whatsapp_accounts.phone_number_id` — every read of both is still live.
--
-- All four move to TAR-820, which lands them in the same release as the writers
-- that satisfy them. This file is the part that is genuinely safe on its own,
-- and the migrate/contract steps are one migration each behind it.
--
-- The fourth, `contacts.phone_e164` losing its NOT NULL, **is** additive — it
-- only widens what the column accepts — so it is here, per this issue's
-- acceptance criteria.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Bounded by two backfills. One row per `whatsapp_accounts` row
--                (single digits per tenant) and one per `contacts` row, plus one
--                UPDATE touching every `conversations` row. On the measured
--                fixture scale — 120 000 conversations, 60 000 contacts — that
--                is seconds, and it rewrites the `conversations` heap once.
--   Locks        ACCESS EXCLUSIVE on `conversations` and `contacts` for their
--                ALTERs, held for the whole transaction because Prisma wraps a
--                migration in one. `ADD COLUMN` with no default and
--                `DROP NOT NULL` are both catalog-only in PostgreSQL 11+, so the
--                lock is cheap to take; the UPDATE that follows is what costs
--                time. `lock_timeout` below makes the DDL fail fast rather than
--                queue behind the inbox.
--   Blocking     Real, and the reason this is a pre-production change. On a live
--                inbox the `conversations` UPDATE would block writes for its
--                duration. This project has no live tenant data; a later
--                environment that does wants the batched form in
--                `docs/runbooks/migrations.md`, not this one.
--   Data loss    None. Nothing is dropped, renamed or retyped, and no existing
--                value is overwritten — every write is into a column or a table
--                that did not exist a statement earlier.
--   Rollback     `down.sql` beside this file, and exact: it drops what was added
--                and restores the NOT NULL. See its own warning about the one
--                case that can refuse.
--
-- ⚠️ **Two things have to run by hand after this migration**, and neither can
-- live in the file:
--
--   1. `prisma/sql/app-roles.sql`. Two new tables carry `tenant_id` and have no
--      grants until it runs, and `verify-tenant-isolation.sql` phase 1 names any
--      table the roles cannot reach.
--   2. `VACUUM (ANALYZE) "public"."conversations";`. Section 8 has the measured
--      numbers and the reason. `VACUUM` is forbidden inside a transaction block
--      and Prisma wraps a migration in one.
--
-- ℹ️ **A seeded environment will show `channels` and `contact_identities` empty,
-- and that is not a fault.** `pnpm db:seed` runs *after* `migrate deploy`, so the
-- WhatsApp numbers and contacts it writes postdate this backfill and get no rows
-- here. Nothing reads either table before TAR-820, and TAR-820's migration
-- re-runs this backfill block verbatim — which picks them up along with
-- everything else written during the window. A developer who wants them sooner
-- can re-run the section 6 block by hand; it is idempotent.
--
-- Additive and idempotent: every statement is guarded, so applying this to a
-- fresh database, to one at the previous version, or twice in a row all succeed.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The two enums
-- ---------------------------------------------------------------------------
--
-- `channel_status` carries the same three values `whatsapp_account_status`
-- already does, moved up to the supertype because they are true of every
-- channel. The old type is **not** dropped or reused: `whatsapp_accounts.status`
-- still uses it until TAR-820 collapses the two, and a shared type would make
-- that a coupled change rather than a sequenced one.
--
-- Sendability stays a separate axis on the provider table
-- (`whatsapp_accounts.registration_status`), for the reason that enum's own
-- comment gives: a number can be `connected` and `unregistered` at the same
-- time, and one column cannot say both.
--
-- `CREATE TYPE` has no `IF NOT EXISTS` form, so both are guarded.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'channel_kind') THEN
        CREATE TYPE "public"."channel_kind" AS ENUM ('whatsapp', 'instagram', 'messenger');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'channel_status') THEN
        CREATE TYPE "public"."channel_status" AS ENUM ('connected', 'disconnected', 'error');
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. `channels`
-- ---------------------------------------------------------------------------
--
-- No credential column, on purpose and permanently. Tokens and PINs stay on the
-- provider-specific table where their AAD binding still names the right thing —
-- `registration_pin_encrypted` is bound to `phone_number_id`, and a PIN that
-- decrypted under a generic channel id would no longer fail when moved between
-- two numbers of one WABA, which is exactly what that binding exists to catch.

CREATE TABLE IF NOT EXISTS "public"."channels" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "public"."channel_kind" NOT NULL,
    "status" "public"."channel_status" NOT NULL DEFAULT 'disconnected',
    "display_name" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "connected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "public"."channels" IS
    'TAR-819, ADR 0013 decision 1. One row per connected messaging endpoint, whatever the '
    'provider. Class-table inheritance: provider-specific columns stay on their own table '
    'joined on this row''s id. A WhatsApp channel takes the id its whatsapp_accounts row '
    'already had, which is what makes conversations.channel_id an identity copy rather than '
    'a remap. Holds no credential — those stay on the provider table.';

COMMENT ON COLUMN "public"."channels"."routing_key" IS
    'The provider''s own id for this endpoint and the webhook routing key: phone_number_id '
    'for WhatsApp, the IG professional account id for Instagram, the Page id for Messenger. '
    'Unique within a kind because one Meta app serves every tenant, so nothing on an inbound '
    'delivery names a tenant except the endpoint it arrived on.';

COMMENT ON COLUMN "public"."channels"."connected_at" IS
    'When the channel last became connected. NULL on every row this migration backfilled, '
    'and that means "never recorded" rather than "never connected": no column on '
    'whatsapp_accounts carried it, and deriving one from created_at would put an invention '
    'into the first column anyone would trust.';

-- `(kind, routing_key)` rather than `(tenant_id, ...)`: this is the one lookup
-- that runs *before* a tenant is known, so it cannot lead with `tenant_id` the
-- way every other unique index in this schema does. It is the generalisation of
-- `whatsapp_accounts.phone_number_id`'s global unique and is reached through
-- `SystemPrisma` for the same documented reason.
CREATE UNIQUE INDEX IF NOT EXISTS "channels_kind_routing_key_key"
    ON "public"."channels"("kind", "routing_key");

-- The composite-foreign-key target (conventions, rule 2): a child naming a
-- channel names `(tenant_id, channel_id)`, so a channel id belonging to another
-- tenant fails in the database rather than in a handler.
CREATE UNIQUE INDEX IF NOT EXISTS "channels_tenant_id_id_key"
    ON "public"."channels"("tenant_id", "id");

-- "Every Instagram account this tenant has connected" — the operator channel
-- list, and the read a per-kind connect limit would use if `whatsappNumbers`
-- ever grows a successor that is actually enforced.
CREATE INDEX IF NOT EXISTS "channels_tenant_id_kind_idx"
    ON "public"."channels"("tenant_id", "kind");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'channels_tenant_id_fkey'
          AND conrelid = 'public.channels'::regclass
    ) THEN
        ALTER TABLE "public"."channels"
            ADD CONSTRAINT "channels_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. `contact_identities`
-- ---------------------------------------------------------------------------
--
-- Scoped by `(tenant, kind)` rather than by channel row, deliberately. A phone
-- number is the same person across every WhatsApp number a tenant connects, so
-- WhatsApp keeps today's cross-number unification. An IGSID is already scoped to
-- the IG account that received it, so two connected IG accounts yield two
-- distinct `external_id` values and cannot collide. One key serves both, and the
-- per-channel column neither needs is not here.

CREATE TABLE IF NOT EXISTS "public"."contact_identities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "kind" "public"."channel_kind" NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_name" TEXT,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_identities_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "public"."contact_identities" IS
    'TAR-819, ADR 0013 decision 2. Who a contact is on one kind of channel: '
    '(tenant_id, kind, external_id) resolves an inbound delivery to a contact_id, replacing '
    '(tenant_id, phone_e164) once TAR-820 routes through it. Makes "one customer, two '
    'channels" representable; does not implement merge.';

COMMENT ON COLUMN "public"."contact_identities"."external_id" IS
    'The provider''s id for this person on this kind of channel: E.164 for WhatsApp, the '
    'IGSID for Instagram, the PSID for Messenger.';

COMMENT ON COLUMN "public"."contact_identities"."display_name" IS
    'The profile name the provider attaches to an inbound batch, per channel. The same '
    'person is a name on WhatsApp and an @handle on Instagram, and contacts.display_name can '
    'only hold one of them.';

-- The inbound resolution key: one index lookup per delivery.
CREATE UNIQUE INDEX IF NOT EXISTS "contact_identities_tenant_id_kind_external_id_key"
    ON "public"."contact_identities"("tenant_id", "kind", "external_id");

CREATE UNIQUE INDEX IF NOT EXISTS "contact_identities_tenant_id_id_key"
    ON "public"."contact_identities"("tenant_id", "id");

-- "Every channel we know this person on" — the contact detail panel, and what a
-- merge would read. Also the index the composite foreign key below needs, so a
-- contact delete does not sequentially scan this table.
CREATE INDEX IF NOT EXISTS "contact_identities_tenant_id_contact_id_idx"
    ON "public"."contact_identities"("tenant_id", "contact_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'contact_identities_tenant_id_fkey'
          AND conrelid = 'public.contact_identities'::regclass
    ) THEN
        ALTER TABLE "public"."contact_identities"
            ADD CONSTRAINT "contact_identities_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'contact_identities_tenant_id_contact_id_fkey'
          AND conrelid = 'public.contact_identities'::regclass
    ) THEN
        ALTER TABLE "public"."contact_identities"
            ADD CONSTRAINT "contact_identities_tenant_id_contact_id_fkey"
            FOREIGN KEY ("tenant_id", "contact_id")
            REFERENCES "public"."contacts"("tenant_id", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Row-level security on both new tables
-- ---------------------------------------------------------------------------
--
-- Both carry `tenant_id`, so both take the standard `tenant_isolation` policy
-- and neither is `system-only` — they are absent from `MODEL_POLICIES` in
-- `tenant-scope.extension.ts`, which is how that file spells "tenant-scoped".
--
-- `channels` is read cross-tenant by the inbound resolver, exactly as
-- `whatsapp_accounts` is today: that read goes through `SystemPrisma`, which
-- connects as `whatsappcrm_system` and is exempt by grant, not by a hole in this
-- policy. A webhook arrives naming a routing key and nothing else, so there is
-- no tenant to set the GUC to.
--
-- The predicate is copied verbatim from `20260810140000_tenant_isolation_rls`.
-- Its two halves both mean "no tenant in scope": `current_setting(..., true)`
-- returns NULL when the GUC was never set, and NULLIF catches the empty string a
-- transaction-local `set_config` leaves behind at commit. Either way the
-- comparison yields NULL, which is not `true`, so the row is filtered out.

ALTER TABLE "public"."channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."channels" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "public"."channels";
CREATE POLICY "tenant_isolation" ON "public"."channels"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "public"."contact_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."contact_identities" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation" ON "public"."contact_identities";
CREATE POLICY "tenant_isolation" ON "public"."contact_identities"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- 5. `conversations.channel_id` and `contacts.phone_e164`
-- ---------------------------------------------------------------------------
--
-- The column is nullable and that is the whole reason this migration is
-- additive. Today's writers set `whatsapp_account_id` alone, so a conversation
-- opened between this release and TAR-820 lands here as NULL — which the
-- composite foreign key added in section 7 tolerates, because a `MATCH SIMPLE`
-- foreign key (Postgres's default) skips the check when any of its columns is
-- NULL. TAR-820's migration backfills the stragglers and then makes the column
-- `NOT NULL`, in the same release as the writers that populate it.
--
-- `ADD COLUMN` with no default is catalog-only in PostgreSQL 11+: no table
-- rewrite, so the ACCESS EXCLUSIVE lock is cheap to take. The UPDATE in section
-- 6 is where the time goes.

ALTER TABLE "public"."conversations" ADD COLUMN IF NOT EXISTS "channel_id" UUID;

COMMENT ON COLUMN "public"."conversations"."channel_id" IS
    'TAR-819. The channel this thread belongs to — a byte-for-byte copy of '
    'whatsapp_account_id, because a channels row takes the id its whatsapp_accounts row '
    'already had. Nullable and unread until TAR-820, which backfills the stragglers, makes '
    'it NOT NULL and drops the column it replaces.';

-- `phone_e164` stops being the identity key and becomes the phone number **when
-- one is known** — which is what contact search, export and the CRM view read.
-- An Instagram contact has no phone number anywhere in it, and the alternative
-- (a synthetic value in an E.164 column) would corrupt the one field the CRM
-- view is trusted for.
--
-- Purely widening: every existing row keeps its value, every existing insert
-- still supplies one, and the `(tenant_id, phone_e164)` unique index is
-- untouched and still live. Nothing can yet create a contact without a phone
-- number — that arrives with TAR-822.
ALTER TABLE "public"."contacts" ALTER COLUMN "phone_e164" DROP NOT NULL;

COMMENT ON COLUMN "public"."contacts"."phone_e164" IS
    'E.164, the contact''s phone number when one is known. Nullable since TAR-819 and no '
    'longer the identity key: contact_identities holds identity now, and '
    '(tenant_id, ''whatsapp'', phone_e164) there is what (tenant_id, phone_e164) was here. '
    'The unique index on this column is still the live key until TAR-820 moves inbound '
    'resolution across.';

-- ---------------------------------------------------------------------------
-- 6. The backfills
-- ---------------------------------------------------------------------------
--
-- `FORCE ROW LEVEL SECURITY` is toggled off around every statement below, and
-- that is not a shortcut. The `tenant_isolation` policy compares against
-- `app.tenant_id`, no migration sets that GUC, and there is no single tenant
-- these statements could set it to. With FORCE on, the policy's USING half makes
-- the `conversations` UPDATE match **zero rows and report success** — a silent
-- no-op, which is the worst failure available here. The same toggle, for the
-- same reason, is in `20260811120000_conversations_last_message_at_not_null`.
--
-- ⚠️ **The toggle covers the tables these statements READ, not only the ones
-- they write.** `FORCE` binds the table owner, and the owner is the role a
-- migration runs as — `20260815120000_branding_and_custom_domains` states it
-- outright: "the migration owner is **not** exempt from FORCE". So a `SELECT`
-- from `whatsapp_accounts` or `contacts` with FORCE on returns **zero rows**,
-- and `INSERT … SELECT` then inserts nothing and reports success. Reproduced on
-- `postgres:16-alpine` with a non-superuser owner and this policy copied
-- verbatim: source table holds 1 row, the owner reads 0, the insert reports 0.
--
-- That failure is invisible in the environments most likely to run this.
-- `docker-compose.yml` connects as the container's initdb superuser and
-- `render.yaml` records that a managed instance's migration owner is one too,
-- and a superuser bypasses RLS outright — so the toggles are inert there and no
-- test can distinguish a correct list from an incomplete one. The list is
-- therefore maintained by rule rather than by observation: **every table named
-- inside this block, in any clause, appears in the toggle.**
-- `20260810160000_whatsapp_business_account_entity` and
-- `20260816150100_reporting_attribution_backfill` both toggle tables they only
-- read, for exactly this reason. `channel_backfill_toggles_every_table_it_reads`
-- in `channel-schema.int-spec.ts` checks the rule against this file's text and
-- the live catalog, since nothing else can.
--
-- Safe inline: DDL is transactional in Postgres, this migration holds ACCESS
-- EXCLUSIVE on these tables for its whole duration so no other session can read
-- them while FORCE is off, and an abort — including the RAISE below — rolls the
-- toggle back with everything else. Every statement is explicitly
-- `tenant_id`-per-row from the table it reads, so none of them can write a row
-- into the wrong tenant.

DO $$
DECLARE
    channel_rows      bigint;
    identity_rows     bigint;
    conversation_rows bigint;
    orphan_rows       bigint;
    expected_channels bigint;
    expected_ids      bigint;
BEGIN
    -- Written to.
    EXECUTE 'ALTER TABLE "public"."channels" NO FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."contact_identities" NO FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."conversations" NO FORCE ROW LEVEL SECURITY';
    -- Read from. Just as necessary — see the warning above.
    EXECUTE 'ALTER TABLE "public"."whatsapp_accounts" NO FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."contacts" NO FORCE ROW LEVEL SECURITY';

    -- The precondition, asserted rather than assumed, and **before** anything
    -- reads a row.
    --
    -- A missing entry above cannot be caught by counting rows afterwards: the
    -- counts would be read through the same blindfold, both sides would come
    -- back 0, and `0 = 0` passes. Measured — on a database owned by a
    -- non-superuser, with `whatsapp_accounts` and `contacts` left FORCEd, the
    -- backfill inserted nothing, the row-count checks below agreed with it, and
    -- the migration committed clean.
    --
    -- The catalog is the one thing RLS cannot hide. This reads it, so it is true
    -- everywhere: under a superuser owner, where the toggles are inert and no
    -- behavioural test can tell a complete list from an empty one, it still
    -- fails loudly on a table someone forgot.
    IF EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relforcerowsecurity
           AND c.relname IN (
               'channels', 'contact_identities', 'conversations',
               'whatsapp_accounts', 'contacts'
           )
    ) THEN
        RAISE EXCEPTION
            'the backfill still has FORCE ROW LEVEL SECURITY on %; with FORCE on and no '
            'app.tenant_id set it would read and write zero rows and report success',
            (
                SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
                  FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public'
                   AND c.relforcerowsecurity
                   AND c.relname IN (
                       'channels', 'contact_identities', 'conversations',
                       'whatsapp_accounts', 'contacts'
                   )
            );
    END IF;

    -- 6a. One channel per connected WhatsApp number, **reusing its id**.
    --
    -- `status` casts through text rather than by ordinal: the two enums happen
    -- to list their three values in the same order today, and an ordinal cast
    -- would keep working right up until one of them gains a value and then
    -- silently mislabel every row. Both types are declared over the same three
    -- labels, so a text cast either matches or raises.
    --
    -- `display_name` prefers Meta's verified name and falls back to the display
    -- phone number. `NULLIF(btrim(...), '')` because a verified name that is
    -- whitespace is not a name, and this column is what an operator reads in a
    -- channel list.
    --
    -- `connected_at` is NULL for every row: see the column comment.
    INSERT INTO "public"."channels" (
        "id", "tenant_id", "kind", "status",
        "display_name", "routing_key", "connected_at", "created_at", "updated_at"
    )
    SELECT
        wa."id",
        wa."tenant_id",
        'whatsapp'::"public"."channel_kind",
        wa."status"::text::"public"."channel_status",
        COALESCE(NULLIF(btrim(wa."verified_name"), ''), wa."display_phone_number"),
        wa."phone_number_id",
        NULL,
        wa."created_at",
        wa."updated_at"
    FROM "public"."whatsapp_accounts" wa
    ON CONFLICT ("id") DO NOTHING;

    GET DIAGNOSTICS channel_rows = ROW_COUNT;

    -- 6b. One WhatsApp identity per contact.
    --
    -- Ids are supplied rather than defaulted: `schema.prisma` generates UUIDv7
    -- in the Prisma client and no PostgreSQL release before 18 has a native
    -- `uuidv7()`, so there is no column default to fall back on. The expression
    -- lays one out per RFC 9562 section 5.7 — 48 bits of Unix milliseconds, the
    -- version nibble, then the random tail of a `gen_random_uuid()`, whose
    -- variant bits already sit in the right place. The same expression as
    -- `20260813130000_sla_pause_accounting_and_alerts`.
    --
    -- `clock_timestamp()` rather than `now()`, so rows written by one statement
    -- do not all share a millisecond prefix.
    --
    -- `display_name` and `last_seen_at` are copied from the contact because
    -- today they *are* the WhatsApp profile's: the inbound writer is the only
    -- thing that sets either, and it sets them from Meta's profile name and the
    -- message timestamp.
    --
    -- The `IS NOT NULL` guard is defensive rather than load-bearing — the column
    -- was NOT NULL until a few statements ago — but this file is also the one a
    -- re-run applies, and by then it is not.
    INSERT INTO "public"."contact_identities" (
        "id", "tenant_id", "contact_id", "kind",
        "external_id", "display_name", "last_seen_at", "created_at"
    )
    SELECT
        (
            lpad(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0')
            || '7'
            || substr(replace(gen_random_uuid()::text, '-', ''), 14)
        )::uuid,
        c."tenant_id",
        c."id",
        'whatsapp'::"public"."channel_kind",
        c."phone_e164",
        c."display_name",
        c."last_seen_at",
        c."created_at"
    FROM "public"."contacts" c
    WHERE c."phone_e164" IS NOT NULL
    ON CONFLICT ("tenant_id", "kind", "external_id") DO NOTHING;

    GET DIAGNOSTICS identity_rows = ROW_COUNT;

    -- 6c. The identity copy. This is the statement the whole plan rests on, and
    -- it is deliberately the least clever one in the file.
    UPDATE "public"."conversations"
       SET "channel_id" = "whatsapp_account_id"
     WHERE "channel_id" IS NULL;

    GET DIAGNOSTICS conversation_rows = ROW_COUNT;

    -- 6d. Did 6a and 6b actually reach every row?
    --
    -- The second half of the guard the toggle assertion above starts. That one
    -- covers the case where the source table is *hidden*; this one covers a
    -- source that is visible but was silently narrowed — a predicate that
    -- excludes more than it means to, a join that drops rows, a conflict target
    -- that swallows them. An empty `channels` otherwise commits cleanly on a
    -- database whose `conversations` table happens to be empty too: 6e below
    -- would find no orphans, the deploy would pass, and the first thing to
    -- notice would be TAR-820's foreign key.
    --
    -- Equality, not "greater than zero". A fresh database legitimately has zero
    -- of both, and both sides being zero is a pass; one side being short by any
    -- amount is not.
    SELECT count(*) INTO expected_channels FROM "public"."whatsapp_accounts";
    SELECT count(*) INTO expected_ids
      FROM "public"."contacts" WHERE "phone_e164" IS NOT NULL;

    IF (SELECT count(*) FROM "public"."channels") <> expected_channels THEN
        RAISE EXCEPTION
            'channels holds % row(s) for % whatsapp_accounts row(s); the backfill in 6a '
            'did not reach every number',
            (SELECT count(*) FROM "public"."channels"), expected_channels;
    END IF;

    IF (SELECT count(*) FROM "public"."contact_identities" WHERE "kind" = 'whatsapp')
       <> expected_ids THEN
        RAISE EXCEPTION
            'contact_identities holds % whatsapp row(s) for % contact(s) with a phone '
            'number; the backfill in 6b did not reach every contact',
            (SELECT count(*) FROM "public"."contact_identities" WHERE "kind" = 'whatsapp'),
            expected_ids;
    END IF;

    -- 6e. The assertion that makes 6c meaningful. Every conversation now names a
    -- channel row, because every `whatsapp_account_id` was a `whatsapp_accounts`
    -- id and 6a gave each of those a channel under the same id. If that is ever
    -- false the foreign key in section 7 would raise anyway — but it would raise
    -- naming a constraint, and this raises naming the reason.
    SELECT count(*) INTO orphan_rows
      FROM "public"."conversations" cv
     WHERE cv."channel_id" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM "public"."channels" ch
            WHERE ch."tenant_id" = cv."tenant_id" AND ch."id" = cv."channel_id"
       );

    IF orphan_rows > 0 THEN
        RAISE EXCEPTION
            '% conversation(s) name a whatsapp_account_id with no channels row; '
            'the id-preserving backfill in 6a did not cover them', orphan_rows;
    END IF;

    EXECUTE 'ALTER TABLE "public"."channels" FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."contact_identities" FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."conversations" FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."whatsapp_accounts" FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."contacts" FORCE ROW LEVEL SECURITY';

    RAISE NOTICE 'channels: % row(s); contact_identities: % row(s); conversations.channel_id: % row(s)',
        channel_rows, identity_rows, conversation_rows;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. The constraints that depend on the backfill
-- ---------------------------------------------------------------------------
--
-- Built after the UPDATE rather than before it: a unique index maintained
-- incrementally through a full-table UPDATE costs more than one sorted build
-- afterwards, and the foreign key validates the rows once instead of per-write.
--
-- The unique index is the successor to
-- `conversations_tenant_id_whatsapp_account_id_contact_id_key` — one thread per
-- contact per channel, the same rule stated on the channel. It **enforces
-- nothing yet**: a unique index does not collide NULLs, and every conversation
-- written between this release and TAR-820 has a NULL `channel_id`. The old
-- constraint holds the invariant during that window and TAR-820's contract
-- migration drops it with the column. Creating this one now means the index is
-- already built and analysed when TAR-820 flips the column to NOT NULL, rather
-- than being built under a live inbox.
--
-- It also cannot fail here: `channel_id` is a copy of `whatsapp_account_id`, so
-- a collision on `(tenant_id, channel_id, contact_id)` would require one on
-- `(tenant_id, whatsapp_account_id, contact_id)`, which is already unique.

CREATE UNIQUE INDEX IF NOT EXISTS "conversations_tenant_id_channel_id_contact_id_key"
    ON "public"."conversations"("tenant_id", "channel_id", "contact_id");

-- Composite, per conventions rule 2: `(tenant_id, channel_id)` against
-- `channels (tenant_id, id)`, so a channel id belonging to another tenant fails
-- in the database rather than in a handler. `Cascade`, because a thread without
-- its channel is unreachable — the same actions the `whatsapp_accounts`
-- reference already carries.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'conversations_tenant_id_channel_id_fkey'
          AND conrelid = 'public.conversations'::regclass
    ) THEN
        ALTER TABLE "public"."conversations"
            ADD CONSTRAINT "conversations_tenant_id_channel_id_fkey"
            FOREIGN KEY ("tenant_id", "channel_id")
            REFERENCES "public"."channels"("tenant_id", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 8. Statistics — and the VACUUM this file cannot run
-- ---------------------------------------------------------------------------
--
-- `conversations` has just had every row rewritten and gained an index; the two
-- new tables have never been analysed at all. Without this the planner works
-- from stale or default estimates on the product's hottest table for as long as
-- it takes autovacuum to notice, which on a table this size is not immediate.

ANALYZE "public"."conversations";
ANALYZE "public"."channels";
ANALYZE "public"."contact_identities";

-- ⚠️ **`ANALYZE` is not enough, and the missing half has to run by hand.**
--
-- All three documented inbox indexes are served by an **Index Only Scan**, which
-- is only index-only while the visibility map says the pages are all-visible.
-- Section 6c rewrote every row of `conversations`, so every visibility-map bit
-- is now clear and each of those scans falls back to the heap. Measured on this
-- migration against the fixture the index comments were written for — 120 000
-- conversations, 2 000 of them the principal's, one 25-row page:
--
--   before this migration     4 buffers, Heap Fetches 0
--   immediately after         53 buffers, Heap Fetches 50   <- same plan, 13x the reads
--   after VACUUM (ANALYZE)    4 buffers, Heap Fetches 0     <- baseline restored, exactly
--
-- The *plan* never changes — same index, same index conditions, no sort, no
-- filter, `Rows Removed by Filter` stays 0 — so the column order those comments
-- protect is intact. What changes is whether the scan touches the heap, and only
-- a VACUUM resets that. Autovacuum gets there on its own; on this table
-- "eventually" is measured in inbox latency until it does.
--
-- `VACUUM` cannot run inside a transaction block and Prisma wraps every
-- migration in one, so this file cannot do it. Run it immediately after
-- applying, in the same window as the `app-roles.sql` re-run:
--
--   VACUUM (ANALYZE) "public"."conversations";
