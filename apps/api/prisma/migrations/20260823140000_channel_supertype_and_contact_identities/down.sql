-- Reverses 20260823140000_channel_supertype_and_contact_identities.
--
-- Exact, and reversible in full: the forward migration created two tables, two
-- enum types, one column, one unique index and one foreign key, and relaxed one
-- NOT NULL. This drops each of them and restores the NOT NULL.
--
-- ⚠️ **Roll the application back first — or rather, do not bother.** At this
-- migration's version nothing in the application reads `channels`,
-- `contact_identities` or `conversations.channel_id`; that is the migration's own
-- acceptance criterion. So this rollback is invisible to a running instance, and
-- the usual "roll the app back first" ordering has nothing to protect here. The
-- release this reverses is additive, which is exactly why redeploying the
-- previous build is normally enough on its own and this file rarely needs to
-- run (`docs/runbooks/migrations.md`, "Rolling back a release").
--
-- ⚠️ **The `channels` and `contact_identities` rows are destroyed.** Every one of
-- them is derived — `channels` from `whatsapp_accounts`, `contact_identities`
-- from `contacts` — so re-applying the forward migration reconstructs both
-- exactly, with one difference worth knowing: `contact_identities.id` is
-- generated at backfill time, so the reconstructed rows carry **new ids**. That
-- matters to nothing today, because nothing references them. It would matter
-- after TAR-820; by then this is not the migration being rolled back.
--
-- ⚠️ **The one case where this refuses.** `ALTER COLUMN phone_e164 SET NOT NULL`
-- fails if any contact has a NULL phone number by then. That cannot happen at
-- this migration's version — nothing can create such a contact until TAR-822 —
-- but if it ever does, the failure is correct and loud: the alternative is
-- inventing a phone number for a customer who does not have one. Resolve those
-- rows deliberately before rolling back, and the statement will succeed.
--
-- ⚠️ **Re-run `prisma/sql/app-roles.sql` afterwards.** The two dropped tables
-- leave stale grants behind them; the file is idempotent and re-running it is
-- how every other table-shaped change here is settled.
--
-- Statements are in reverse order of the forward file: the dependants go before
-- what they depend on, so the enum types are dropped only once no column uses
-- them.

SET LOCAL lock_timeout = '3s';

-- 7 (reverse). The conversations foreign key and its unique index. Dropping the
-- column below would take both with it, but naming them keeps this file a
-- statement-for-statement mirror and keeps the failure legible if one has
-- already been removed by hand.
ALTER TABLE "public"."conversations"
    DROP CONSTRAINT IF EXISTS "conversations_tenant_id_channel_id_fkey";

DROP INDEX IF EXISTS "public"."conversations_tenant_id_channel_id_contact_id_key";

-- 5 (reverse). The column, and the NOT NULL that was relaxed beside it.
ALTER TABLE "public"."conversations" DROP COLUMN IF EXISTS "channel_id";

ALTER TABLE "public"."contacts" ALTER COLUMN "phone_e164" SET NOT NULL;

COMMENT ON COLUMN "public"."contacts"."phone_e164" IS NULL;

-- 4, 3, 2 (reverse). Each table takes its own indexes, policy, primary key and
-- foreign keys with it, so two statements are the whole reversal of three
-- sections. `contact_identities` first: it references `contacts`, and `channels`
-- references only `tenants`, so neither depends on the other and the order is
-- simply the reverse of creation.
DROP TABLE IF EXISTS "public"."contact_identities";

DROP TABLE IF EXISTS "public"."channels";

-- 1 (reverse). Safe only because both tables above are gone — a type still used
-- by a column refuses to drop, which is the right failure and not one this file
-- should mask with CASCADE.
DROP TYPE IF EXISTS "public"."channel_status";

DROP TYPE IF EXISTS "public"."channel_kind";

-- `conversations` has just lost a column and an index. Re-analysing costs
-- milliseconds and stops the planner working from statistics that describe a
-- table shape which no longer exists.
ANALYZE "public"."conversations";
