-- Reverses 20260823120000_whatsapp_number_registration_status_and_pin.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- ⚠️ What this destroys, and what it does not
-- ---------------------------------------------------------------------------
--
-- `DROP COLUMN registration_pin_encrypted` takes every stored registration PIN
-- with it. That matters more than the column count suggests: a number Meta has
-- already accepted stays registered at Meta under a PIN this platform then no
-- longer holds, and Meta offers no way to read one back. Re-registering that
-- number afterwards means either Meta accepting a different PIN — which the
-- contract records as unverified (TAR-766, open question 2) — or a support
-- conversation to reset it.
--
-- So the safe window for this file is the same one every rollback has: promptly,
-- against a deploy of TAR-767 that TAR-768 has not yet followed, while
-- `registration_pin_encrypted` is still NULL on every row because nothing writes
-- it yet. The guard below refuses to run outside that window rather than
-- discovering it afterwards, and names the override for the case where the
-- caller genuinely means it.
--
-- The override is a session GUC set before this file rather than a flag inside
-- it, which also means it is only reachable on the by-hand `psql` path.
-- `pnpm db:rollback` sends the bookkeeping delete and this file as one batch and
-- has nowhere to set it — so through that script this rollback simply refuses
-- while any PIN is stored, which for a credential is the right default.
--
-- Nothing else here loses information that the previous version could use:
-- `registration_status` on a rolled-back build is a column Prisma's client does
-- not know, and `registered_at` records an event the audit log also records.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. `DROP COLUMN` marks the attribute dropped; the
--                space is reclaimed by later vacuums, not by this statement.
--   Locks        ACCESS EXCLUSIVE on `whatsapp_accounts`, for the length of the
--                transaction, plus a brief one on the type.
--   Blocking     Not an online operation — a reader mid-drop fails. Capped at
--                three seconds by `lock_timeout`, so a busy table aborts this
--                rather than queueing behind it.
--   Roles        No table is created or dropped, so there is nothing for
--                `pnpm db:roles` to re-assert. The `tenant_isolation` and
--                `system_unrestricted` policies on `whatsapp_accounts` predicate
--                on `tenant_id` and are untouched throughout.
--   Order        The type is dropped after the column that references it. The
--                reverse fails on the dependency, which is the right failure but
--                a confusing one to read at 2 a.m.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql` — which is in autocommit, so without it a
-- failure halfway through would leave the table half-reverted and
-- `SET LOCAL lock_timeout` would be a no-op warning rather than a limit. It is
-- also what lets `db-rollback.mjs` send this file and the `_prisma_migrations`
-- delete as one transaction (TAR-346).
--
-- Not applied automatically — see the "Rolling a migration back" section of
-- README.md, including the `_prisma_migrations` row that has to be deleted
-- afterwards.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Guard. Refuses to discard registration PINs that are actually in use.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    pinned_rows bigint;
BEGIN
    -- Counted with FORCE suspended for the reason
    -- 20260810160000_whatsapp_business_account_entity states at length: the
    -- migration owner is not exempt from FORCE ROW LEVEL SECURITY and no
    -- `app.tenant_id` is set here, so a plain count reads zero on a full table
    -- and waves through exactly the case this guard exists to stop.
    --
    -- Safe inline: DDL is transactional, this transaction holds ACCESS EXCLUSIVE
    -- on the table for its whole duration so no other session can read it while
    -- FORCE is off, and an abort rolls the toggle back with everything else.
    EXECUTE 'ALTER TABLE "public"."whatsapp_accounts" NO FORCE ROW LEVEL SECURITY';

    SELECT count(*) INTO pinned_rows
      FROM "public"."whatsapp_accounts"
     WHERE "registration_pin_encrypted" IS NOT NULL;

    EXECUTE 'ALTER TABLE "public"."whatsapp_accounts" FORCE ROW LEVEL SECURITY';

    IF pinned_rows > 0 AND current_setting('whatsappcrm.discard_registration_pins', true) IS DISTINCT FROM 'yes' THEN
        RAISE EXCEPTION
            'TAR-767 rollback refuses to run: % row(s) hold a registration PIN', pinned_rows
            USING HINT =
                'Dropping registration_pin_encrypted destroys the only copy of a PIN Meta has '
                'already accepted, and Meta will not read one back. Roll back the code that '
                'writes it first, or — if the PINs are genuinely disposable — take a verified '
                'backup and re-run this file in a psql session that issued '
                'SET "whatsappcrm.discard_registration_pins" = ''yes''; beforehand. Session '
                'level, not SET LOCAL: this file opens its own transaction, so there is no '
                'earlier statement inside it to set.';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Schema change.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "public"."whatsapp_accounts" DROP COLUMN "registered_at",
DROP COLUMN "registration_attempted_at",
DROP COLUMN "registration_failure_reason",
DROP COLUMN "registration_pin_encrypted",
DROP COLUMN "registration_status";

-- DropEnum
DROP TYPE "public"."whatsapp_registration_status";

COMMIT;
