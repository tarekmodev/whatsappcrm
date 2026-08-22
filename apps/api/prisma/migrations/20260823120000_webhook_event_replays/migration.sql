-- The trail for an operator replaying a parked webhook event (TAR-94).
--
-- TAR-67 shipped the recovery *mechanism* and no authorised way to reach it:
-- `WebhookEventsRepository.claim()` refuses a `failed` row on purpose, so
-- replaying one is a reset back to `received` that the next sweep collects — and
-- until now that reset was an operator typing `UPDATE webhook_events` into psql,
-- with nothing recording that they had. This table is what the endpoint
-- replacing that writes.
--
-- ---------------------------------------------------------------------------
-- Why a table of its own rather than an `audit_logs` row
-- ---------------------------------------------------------------------------
--
-- `audit_logs.tenant_id` is NOT NULL and carries the `tenant_isolation` policy,
-- and the parked event this feature exists to recover is precisely the one with
-- no tenant. `unknown_phone_number_id` means a number was connected *after* its
-- customers had already messaged it, so `webhook_events.tenant_id` is NULL and
-- there is nothing to file the entry under. Naming a tenant the operator
-- asserted would put an invention into the table whose entire value is being
-- right about what happened, and the alternative — replaying with no trail — is
-- an operator action on production state that nobody can account for afterwards.
--
-- So the trail takes the posture of the table it describes: no `tenant_id`, no
-- RLS policy, and no grant at all for `whatsappcrm_app`. On this table, as on
-- `webhook_events`, `tenant_signups` and `lifecycle_events`, **the grant is the
-- enforcement** — `app-roles.sql` is updated in the same change and has to be
-- re-run after this migration, or `verify-tenant-isolation.sql` fails on it.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. One empty table, one index, one foreign key and
--                one trigger function. Nothing existing is read or rewritten.
--   Locks        ACCESS EXCLUSIVE on the new table, which no session can be
--                holding, and SHARE ROW EXCLUSIVE on `webhook_events` for the
--                foreign key. `lock_timeout` is set below so the FK fails fast
--                rather than queueing behind ingest.
--   Blocking     Nil in practice. Ingest writes `webhook_events` continuously;
--                the FK's lock is taken for the statement only.
--   Data loss    None. Purely additive — nothing is dropped, renamed or retyped.
--   Rollback     `down.sql` beside this file. Reversible in full, and it drops a
--                table nothing else references.
--
-- Additive and idempotent: every statement is guarded, so applying this to a
-- fresh database, to one at the previous version, or twice in a row all succeed.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
--
-- One row per replay rather than a pair of columns on `webhook_events`, because
-- "who last replayed this" is not the question an incident asks. An event
-- replayed three times — a number connected wrong, then connected right — is a
-- different fact from one replayed once, and a column that keeps only the newest
-- attempt cannot tell them apart.
--
-- `parked_error` is a copy rather than a reference for the same reason the row
-- exists at all: the replay itself clears `webhook_events.last_error`, so
-- without this column the trail would say an event was replayed and not what was
-- being recovered.

CREATE TABLE IF NOT EXISTS "public"."webhook_event_replays" (
    "id" UUID NOT NULL,
    "webhook_event_id" UUID NOT NULL,
    "actor_label" TEXT NOT NULL,
    "parked_error" TEXT,
    "replayed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_event_replays_pkey" PRIMARY KEY ("id")
);

COMMENT ON TABLE "public"."webhook_event_replays" IS
    'TAR-94. Append-only, one row per operator-triggered replay of a parked webhook_events '
    'row. No tenant_id and no RLS policy, for the same reason as webhook_events: the event '
    'being recovered may predate any tenant knowing about it. Reachable through SystemPrisma '
    'alone — the app role holds no grant, which is what replaces the policy.';

COMMENT ON COLUMN "public"."webhook_event_replays"."actor_label" IS
    'The label half of the PLATFORM_ADMIN_TOKEN entry that authenticated the request, never '
    'the secret half. Same value audit_logs.actor_label carries for an operator action inside '
    'a tenant (TAR-166).';

COMMENT ON COLUMN "public"."webhook_event_replays"."parked_error" IS
    'The webhook_events.last_error the row carried when it was replayed. Copied because the '
    'replay clears it, and why an event was parked is what the trail is read for.';

-- The index answers "has this event been replayed before, and how often", which
-- is what an operator asks before replaying it again. `replayed_at` is the second
-- column so the newest replay for one event is a backwards index scan rather
-- than a sort.

CREATE INDEX IF NOT EXISTS "webhook_event_replays_webhook_event_id_replayed_at_idx"
    ON "public"."webhook_event_replays"("webhook_event_id", "replayed_at");

-- ON DELETE CASCADE, unlike `lifecycle_events`, which deliberately dropped its
-- foreign keys so the trail could outlive the tenant it names. The difference is
-- what the row means: a lifecycle entry is a statement about a tenant and stands
-- on its own once the tenant is purged, while a replay row without its event is
-- an id, a label and nothing recoverable. Nothing deletes a `webhook_events` row
-- today; if a retention sweep ever does, this trail goes with the payload it
-- describes rather than outliving it as an orphan.
--
-- Guarded rather than `IF NOT EXISTS`, which `ADD CONSTRAINT` has no form of.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'webhook_event_replays_webhook_event_id_fkey'
          AND conrelid = 'public.webhook_event_replays'::regclass
    ) THEN
        ALTER TABLE "public"."webhook_event_replays"
            ADD CONSTRAINT "webhook_event_replays_webhook_event_id_fkey"
            FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_events"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Append-only, enforced against the owner too
-- ---------------------------------------------------------------------------
--
-- The grants in `app-roles.sql` give `whatsappcrm_system` SELECT and INSERT and
-- withhold UPDATE and DELETE, which closes every application path. This closes
-- the other one: the table owner is bound by neither grant, and the owner is the
-- credential a psql session runs as at 2 a.m. — which is exactly the situation
-- this trail exists to record rather than to be edited during.
--
-- The same shape as `lifecycle_events_append_only` and the same SQLSTATE, with
-- no permitted-update exception because there is no column here to settle later.
-- DELETE is deliberately left alone: the ON DELETE CASCADE above *is* a DELETE,
-- and blocking it would make a `webhook_events` row undeletable — a bigger
-- promise than this table should make on the ingest table's behalf.

CREATE OR REPLACE FUNCTION "public"."webhook_event_replays_forbid_update"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION 'webhook_event_replays is append-only: row % cannot be updated', OLD."id"
        USING ERRCODE = 'TN002',
              HINT = 'A replay is a fact that happened. Record a correction as a new replay, '
                     'not as an edit to the old one.';
END;
$$;

COMMENT ON FUNCTION "public"."webhook_event_replays_forbid_update"() IS
    'TAR-94. Raises TN002 on any UPDATE of webhook_event_replays, including by the table '
    'owner. The grants withhold UPDATE from both application roles; this is the half they '
    'cannot cover.';

DROP TRIGGER IF EXISTS "webhook_event_replays_append_only"
    ON "public"."webhook_event_replays";

CREATE TRIGGER "webhook_event_replays_append_only"
    BEFORE UPDATE ON "public"."webhook_event_replays"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."webhook_event_replays_forbid_update"();
