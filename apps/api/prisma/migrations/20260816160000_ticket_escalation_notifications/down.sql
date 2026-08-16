-- Reverses 20260816160000_ticket_escalation_notifications.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- What this costs, and when it is safe
-- ---------------------------------------------------------------------------
--
-- **Lossless while no `escalation` notification exists**, which is every
-- environment until TAR-469 ships the escalate route. Nothing writes the column
-- before then, so applying this returns the database exactly to its previous
-- state.
--
-- **After TAR-469 it destroys the delivery record of every escalation.**
-- Dropping `ticket_event_id` does not drop the rows — but it strips them of the
-- thing that identifies them, and the CHECK is gone with it, so what is left is
-- a set of `escalation`-typed rows that no longer name the event they belong to.
-- That is worse than deleting them: the escalation view would render
-- notifications it cannot group, explain or acknowledge coherently.
--
-- So the delete below is deliberate and comes first. It is the only destructive
-- statement in either direction of this story, and the reasoning is:
--
--   * The rows cannot be repaired. Recipient resolution happened at escalation
--     time against the tenant's supervisors and the ticket's team as they stood
--     then; replaying it later produces a different set and dates it wrongly.
--   * Re-applying the forward migration cannot re-derive them either, for the
--     same reason.
--   * Leaving them typed `escalation` with no event is the state the CHECK
--     exists to make impossible, and re-applying the migration would then fail
--     on its own constraint — a rollback that blocks the roll-forward.
--
-- **The escalations themselves survive.** The `escalated` rows in `ticket_events`
-- are untouched by this script, so the ticket's audit trail — TAR-32's actual
-- acceptance criterion — stays intact and complete. What is destroyed is the
-- record of *who was told*.
--
-- ⚠️ **Take a verified backup of `notifications` before applying this to an
-- environment that has served an escalation.** Past that point the forward fix
-- is a new migration, not this file.
--
-- ---------------------------------------------------------------------------
-- The enum label is not removed here
-- ---------------------------------------------------------------------------
--
-- `notification_type.escalation` belongs to `20260816150000`, and PostgreSQL has
-- no `ALTER TYPE ... DROP VALUE` — see that directory's `down.sql`. Once this
-- script has run, no row carries the label and it is inert, which is the state
-- that rollback actually needs.
--
-- ---------------------------------------------------------------------------
-- Dropping the `ticket_events` unique index is cheap and is not symmetric
-- ---------------------------------------------------------------------------
--
-- `DROP INDEX` takes ACCESS EXCLUSIVE on `ticket_events` but does no work — it is
-- a catalogue edit, milliseconds at any table size, unlike the build in the
-- forward migration. `lock_timeout` still caps the wait.
--
-- It costs nothing but the reference target: `id` remains the primary key, so
-- every event stays uniquely identified and no query loses an access path
-- (nothing filters on `(tenant_id, id)` — the ticket history reads through
-- `(tenant_id, ticket_id, created_at DESC, id DESC)`).
--
-- ⚠️ **If the index was built out of band** via the `CONCURRENTLY` path in the
-- forward migration's guard, dropping it here is still correct but leaves the
-- operator's manual step undone on the next re-apply. That is intended — the
-- forward migration is written `IF NOT EXISTS` and rebuilds it inline if the
-- table is small enough, or fails loudly and tells them to repeat the
-- out-of-band step if it is not.
--
-- Order matters: the rows go before the constraint that describes them, the
-- constraint and the foreign key go before the column they name, and the column
-- goes before the `ticket_events` index its foreign key references — PostgreSQL
-- refuses to drop an index that a live foreign key depends on.

SET LOCAL lock_timeout = '3s';

-- Deliberate, and the reasoning is in the header. Runs first so that no row can
-- outlive the column that identifies it.
DELETE FROM "public"."notifications" WHERE "type" = 'escalation';

ALTER TABLE "public"."notifications"
    DROP CONSTRAINT IF EXISTS "notifications_escalation_columns";

ALTER TABLE "public"."notifications"
    DROP CONSTRAINT IF EXISTS "notifications_tenant_id_ticket_event_id_fkey";

DROP INDEX IF EXISTS "public"."notifications_tenant_id_ticket_event_id_recipient_user_id_key";

ALTER TABLE "public"."notifications"
    DROP COLUMN IF EXISTS "ticket_event_id";

DROP INDEX IF EXISTS "public"."ticket_events_tenant_id_id_key";
