-- Whether a connected phone number may **send**, and the PIN that makes it so
-- (TAR-170, 0002 amendment 12).
--
-- ---------------------------------------------------------------------------
-- Why a second axis rather than a value on `whatsapp_account_status`
-- ---------------------------------------------------------------------------
--
-- A number attached through Embedded Signup receives normally the moment the app
-- is subscribed to its WABA's webhooks, and refuses every send until Cloud API's
-- `POST /{phone-number-id}/register` has been called for it. Those are two
-- independent facts about one row, and `whatsapp_account_status`
-- (`connected`/`disconnected`/`error`) can only hold one of them. Adding a
-- `connected_unregistered` label to it would also break every existing
-- `= 'connected'` reader — inbound webhook routing among them — for a number
-- that is, in fact, connected.
--
-- ---------------------------------------------------------------------------
-- Why the default is `unregistered` and not `failed`
-- ---------------------------------------------------------------------------
--
-- Every row this migration touches was connected before registration existed, so
-- nothing was ever attempted for it and Meta never refused anything. `failed`
-- would put a rejection in the state of numbers nobody has asked Meta about, and
-- the console's copy for the two differs: "set up sending" against "sending
-- failed: …". Those rows become sendable through the retry route, or by
-- re-running Embedded Signup — this migration backfills nothing and calls
-- nobody.
--
-- ---------------------------------------------------------------------------
-- The PIN column
-- ---------------------------------------------------------------------------
--
-- `registration_pin_encrypted` holds a credential of the same class as
-- `whatsapp_business_accounts.access_token_encrypted`: the same AES-256-GCM
-- cipher, the same `WHATSAPP_TOKEN_ENCRYPTION_KEY`, the same
-- `v1.<iv>.<tag>.<ciphertext>` envelope. It differs in one respect, and the
-- difference is deliberate — its additional authenticated data is
-- `phone_number_id` rather than `waba_id`, because the PIN lives on the number.
-- Two numbers under one WABA are registered independently and hold different
-- PINs, so a ciphertext copied between their rows must fail to authenticate.
--
-- It is never selected into a response projection and never written to a log or
-- an audit row. `TEXT` rather than `BYTEA` for the same reason the token column
-- is: the envelope is base64url text and stays greppable in a database dump.
--
-- ---------------------------------------------------------------------------
-- `registration_failure_reason` is TEXT, not an enum
-- ---------------------------------------------------------------------------
--
-- The vocabulary grows as Meta's numeric failure codes are mapped, and it is
-- only ever written from a closed TypeScript constant
-- (`WHATSAPP_REGISTRATION_FAILURE_REASONS`) — the arrangement
-- `sessions.revoked_reason` already uses. An enum type would make each new
-- reason an `ALTER TYPE` that cannot be used in the transaction that adds it.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. `CREATE TYPE` is one catalog row;
--                `ADD COLUMN … DEFAULT 'unregistered'` takes PostgreSQL 11+'s
--                non-rewriting path because the default is non-volatile, so no
--                row is touched however many there are. The other three are
--                nullable with no default.
--   Locks        ACCESS EXCLUSIVE on `whatsapp_accounts` for the ALTERs, held to
--                the end of the transaction Prisma wraps this file in. Capped at
--                three seconds by `lock_timeout`.
--   Blocking     Inbound webhook routing reads `whatsapp_accounts` by
--                `phone_number_id`; it queues behind this for those
--                milliseconds. `lock_timeout` makes a blocked migration abort
--                rather than stack deliveries behind it.
--   Rewrite      None.
--   Backfill     None. `unregistered` is the truthful starting value, per above.
--   Data loss    None. Purely additive.
--   Idempotent   `IF NOT EXISTS` on every ALTER, and the `CREATE TYPE` is
--                guarded, so re-running the runner over a database that is
--                already part-migrated succeeds quietly.
--   Rollback     `down.sql` beside this file. Read its header before running it.
--
-- The enum type is created and used in the same transaction, which is safe:
-- PostgreSQL's refusal to *use* a label in the transaction that added it applies
-- to `ALTER TYPE … ADD VALUE` on an existing type, not to a type created here.
-- That is the hazard `20260822120000_workflow_broken_reason_suspended` documents.
--
-- No index. `whatsapp_accounts` is bounded by numbers-per-tenant and every access
-- is by primary key or `phone_number_id`; a `(tenant_id, registration_status)`
-- index would serve a "list every unregistered number" query nothing asks for
-- yet. RLS is unchanged — `whatsapp_accounts` already carries `ENABLE`/`FORCE ROW
-- LEVEL SECURITY` and its `tenant_isolation` policy, and the policy is
-- column-agnostic, so no `pnpm db:roles` re-run is needed in either direction.

SET LOCAL lock_timeout = '3s';

-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "whatsapp_registration_status" AS ENUM ('unregistered', 'pending', 'registered', 'failed');
EXCEPTION
    WHEN duplicate_object THEN
        -- A part-applied run of this same migration. `CREATE TYPE` has no
        -- `IF NOT EXISTS`, so the guard is the exception rather than a clause.
        NULL;
END
$$;

-- AlterTable
ALTER TABLE "public"."whatsapp_accounts"
    ADD COLUMN IF NOT EXISTS "registration_status" "whatsapp_registration_status" NOT NULL DEFAULT 'unregistered';

COMMENT ON COLUMN "public"."whatsapp_accounts"."registration_status" IS
    'TAR-170. Whether this number may send. Independent of status: a number can be connected and '
    'receiving while Cloud API refuses every send from it. Existing rows default to unregistered — '
    'never attempted — rather than failed, which would claim a rejection Meta never made.';

ALTER TABLE "public"."whatsapp_accounts"
    ADD COLUMN IF NOT EXISTS "registration_pin_encrypted" TEXT;

COMMENT ON COLUMN "public"."whatsapp_accounts"."registration_pin_encrypted" IS
    'TAR-170. The six-digit Cloud API registration PIN, encrypted at rest by the same cipher and key '
    'as whatsapp_business_accounts.access_token_encrypted, bound to phone_number_id as AAD. Read back '
    'only to re-register. Never selected into a response, a log line or an audit row.';

ALTER TABLE "public"."whatsapp_accounts"
    ADD COLUMN IF NOT EXISTS "registration_failure_reason" TEXT;

COMMENT ON COLUMN "public"."whatsapp_accounts"."registration_failure_reason" IS
    'TAR-170. Why the last attempt failed, from WHATSAPP_REGISTRATION_FAILURE_REASONS. TEXT rather '
    'than an enum because the vocabulary grows as Meta''s codes are mapped and it is only ever '
    'written from a closed TypeScript constant. NULL unless registration_status is failed.';

ALTER TABLE "public"."whatsapp_accounts"
    ADD COLUMN IF NOT EXISTS "registered_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN "public"."whatsapp_accounts"."registered_at" IS
    'TAR-170. When Meta last accepted this number. Set on every success, never cleared.';

ALTER TABLE "public"."whatsapp_accounts"
    ADD COLUMN IF NOT EXISTS "registration_attempted_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN "public"."whatsapp_accounts"."registration_attempted_at" IS
    'TAR-170. When an attempt last started, and the in-flight lease: a pending row older than '
    'META_GRAPH_API_TIMEOUT_MS is an attempt that died without an answer, and the next one takes it '
    'over. NULL until an attempt has been made.';
