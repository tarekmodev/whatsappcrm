-- Reverses 20260823120000_whatsapp_number_registration.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ⚠️ Roll the application back first. At this migration's version
-- `WhatsAppPhoneNumberRegistrationService` reads and writes all five columns on
-- every connection, so dropping them under a running instance turns every
-- Embedded Signup connection into a 500 — after the WABA row has been written.
--
-- ---------------------------------------------------------------------------
-- What is lost, and why it is the acceptable direction
-- ---------------------------------------------------------------------------
--
-- The forward migration is purely additive, so the reversal is exact in shape:
-- nothing was renamed or retyped and no row's existing data is reinterpreted.
-- What it does discard is every number's registration state — including
-- `registration_pin_encrypted`, the PIN Meta is holding for numbers that
-- registered successfully.
--
-- **That matters, and it is not silently absorbed.** After a re-apply every row
-- reads `unregistered` with no PIN, and a fresh attempt generates a *new* PIN
-- for a number Meta may already have registered under the old one. Meta answers
-- that with an ordinary registration failure, recorded as a reason on the row —
-- so the outcome is a visible, retryable failed state rather than a number that
-- silently cannot send. Recovering it needs a PIN reset at Meta, which is a
-- support conversation and not something this file can do.
--
-- The number keeps **receiving** throughout, in both directions: inbound routing
-- reads `phone_number_id` and `status`, neither of which this touches.
--
-- ---------------------------------------------------------------------------
-- The type goes too
-- ---------------------------------------------------------------------------
--
-- `whatsapp_registration_status` was created by the migration being reversed and
-- is used by nothing else, so unlike an `ALTER TYPE … ADD VALUE` rollback this
-- one can drop it cleanly. `DROP TYPE` after the column that depends on it, and
-- `IF EXISTS` on both so a second run is quiet.
--
-- Locks and duration mirror the up migration: ACCESS EXCLUSIVE on
-- `whatsapp_accounts` for the ALTERs, milliseconds, no rewrite. RLS is untouched
-- — the table keeps `ENABLE`/`FORCE ROW LEVEL SECURITY` and its
-- `tenant_isolation` policy, so no `pnpm db:roles` re-run is needed.
--
-- The explicit transaction is here because this file is applied by hand through
-- `psql`, which is in autocommit. It is also safe under `db:rollback`, which
-- sends the bookkeeping delete and this file as one statement batch: the `BEGIN`
-- below converts that batch's implicit transaction rather than opening a second
-- one (TAR-346), which is why the shape is one outermost `BEGIN` … `COMMIT` and
-- nothing after it.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- Reverse order of the up migration, so nothing here depends on something
-- already removed.
ALTER TABLE "public"."whatsapp_accounts"
    DROP COLUMN IF EXISTS "registration_attempted_at";

ALTER TABLE "public"."whatsapp_accounts"
    DROP COLUMN IF EXISTS "registered_at";

ALTER TABLE "public"."whatsapp_accounts"
    DROP COLUMN IF EXISTS "registration_failure_reason";

ALTER TABLE "public"."whatsapp_accounts"
    DROP COLUMN IF EXISTS "registration_pin_encrypted";

ALTER TABLE "public"."whatsapp_accounts"
    DROP COLUMN IF EXISTS "registration_status";

DROP TYPE IF EXISTS "whatsapp_registration_status";

COMMIT;
