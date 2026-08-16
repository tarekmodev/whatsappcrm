-- Reverses 20260816150000_notification_type_escalation.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- ---------------------------------------------------------------------------
-- ⚠️ PostgreSQL cannot drop an enum label, and this script does not pretend to
-- ---------------------------------------------------------------------------
--
-- There is no `ALTER TYPE ... DROP VALUE`. The only ways to remove `escalation`
-- are to recreate the type — dropping and recreating every column that uses it,
-- which takes ACCESS EXCLUSIVE on `notifications` and rewrites the table — or to
-- delete the row from `pg_enum` by hand, which corrupts any index or row that
-- still references the label.
--
-- **So this script deliberately leaves the label in place**, and that is the
-- correct rollback rather than a shortcut:
--
--   * An unused enum label is completely inert. Nothing reads it, nothing
--     branches on it, and it costs one `pg_enum` row. The version being rolled
--     back to simply never writes it.
--   * `20260816160000_ticket_escalation_notifications` is what makes the label
--     reachable, and its own `down.sql` removes the column, the constraint and
--     the rows. Once that has run, no row can carry `escalation` — which is the
--     state this rollback actually needs.
--   * Re-applying the forward migration finds the label already present and is
--     fine with it: that statement is `ADD VALUE IF NOT EXISTS`, precisely
--     because this script leaves the label behind. The bare form would fail on a
--     database that is already correct.
--
-- If the label genuinely has to go — it does not, but if a future story
-- restructures `notification_type` — that is a type recreation with a verified
-- backup and a maintenance window, planned as its own migration. It is not a
-- rollback step.
--
-- Nothing below is destructive; this file exists so that
-- `pnpm db:check-migrations` sees a rollback path and so that the reasoning
-- above lives next to the migration it explains.

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
    RAISE NOTICE
        'notification_type.escalation is left in place: PostgreSQL has no '
        'ALTER TYPE ... DROP VALUE, and an unused label is inert. The column, '
        'constraint and rows that make it reachable are removed by '
        '20260816160000_ticket_escalation_notifications/down.sql.';
END
$$;
