-- The tenant lifecycle vocabulary (TAR-403, 1 of 2).
--
-- `tenant_status` has carried `pending / active / suspended / cancelled` since
-- TAR-47, while `TENANT_STATUSES` in `@whatsappcrm/contracts` has published
-- `trialing / active / past_due / suspended / cancelled / deleted` since TAR-39.
-- `PROVISIONED_TENANT_STATUSES` names that drift out loud and hands the
-- reconciliation to TAR-36 — this is TAR-36 doing it, and after this migration
-- the column is a superset of the published set.
--
-- Split from the rest of TAR-403 because PostgreSQL will not let a value added
-- to an enum be *used* in the transaction that added it, and Prisma runs each
-- migration directory in one transaction. Everything that writes or constrains
-- on `trialing`, `past_due` or `deleted` therefore lives in
-- `20260815130000_tenant_lifecycle_retention_audit_and_limits`, which is a
-- separate transaction and can. Applying this one alone is a complete,
-- consistent state.
--
-- ---------------------------------------------------------------------------
-- Why `pending` is renamed and not left alongside `created`
-- ---------------------------------------------------------------------------
--
-- They are the same state, spelled twice: "the row exists, provisioning has not
-- finished". TAR-403's acceptance criteria call it `created`; the column calls
-- it `pending`. Keeping both would leave two labels for one state and a mapper
-- that has to know they are the same — which is the class of bug this whole
-- migration exists to remove.
--
-- `ALTER TYPE ... RENAME VALUE` is a catalog update: the enum value keeps its
-- OID, so every stored row, every column default and every index entry that
-- referenced `pending` now reads `created` with nothing rewritten. It is also
-- the cheap direction of an enum change in a way `ADD VALUE` is not — a renamed
-- value is usable immediately, including in this transaction.
--
-- The rename is guarded so a re-run, or a database already at this version, is a
-- no-op rather than an error. `RENAME VALUE` has no `IF EXISTS` form.
--
-- ---------------------------------------------------------------------------
-- Sort order
-- ---------------------------------------------------------------------------
--
-- The three new labels are appended rather than placed with `BEFORE`/`AFTER`.
-- Enum order is the sort order for `ORDER BY status`, and nothing sorts on it —
-- `tenants` is read by id, by slug, or filtered by `status` through
-- `tenants_status_idx` — so position carries no meaning, while a placed
-- `ADD VALUE` cannot be made idempotent with `IF NOT EXISTS`.
--
-- `schema.prisma` lists the labels in this same catalog order for the same
-- reason: `prisma migrate diff` compares the two and would otherwise propose a
-- reordering that is not a real change.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. Four catalog rows. No table is read, rewritten
--                or locked for data.
--   Locks        ACCESS EXCLUSIVE on the `tenant_status` type only, not on
--                `tenants`. Capped at three seconds by the `lock_timeout` below.
--   Blocking     None in practice: nothing holds a lock on a type.
--   Behaviour    `created` behaves exactly as `pending` did — in particular
--                `assert_tenant_active` still refuses it, because provisioning
--                is not finished. The three added labels are inert until
--                something writes them.
--   Rollback     `down.sql` beside this file. The rename reverses; the three
--                added labels stay, and that file says why.
--
-- ---------------------------------------------------------------------------
-- The application change that has to ship with this
-- ---------------------------------------------------------------------------
--
-- `PROVISIONED_TENANT_STATUSES` in `packages/contracts/src/admin.ts` is the
-- response schema for `POST /api/v1/admin/tenants` and its deactivate sibling.
-- It is updated in the same commit: a tenant row reporting `created` against a
-- schema that only knows `pending` fails response validation and answers 500.

SET LOCAL lock_timeout = '3s';

ALTER TYPE "public"."tenant_status" ADD VALUE IF NOT EXISTS 'trialing';
ALTER TYPE "public"."tenant_status" ADD VALUE IF NOT EXISTS 'past_due';
ALTER TYPE "public"."tenant_status" ADD VALUE IF NOT EXISTS 'deleted';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'tenant_status' AND e.enumlabel = 'pending'
    ) THEN
        ALTER TYPE "public"."tenant_status" RENAME VALUE 'pending' TO 'created';
        RAISE NOTICE 'tenant_status: renamed pending to created';
    ELSE
        RAISE NOTICE 'tenant_status: pending is already gone, nothing to rename';
    END IF;
END
$$;

COMMENT ON TYPE "public"."tenant_status" IS
    'TAR-403. The tenant lifecycle vocabulary: created, trialing, active, past_due, suspended, '
    'cancelled, deleted. A superset of TENANT_STATUSES in @whatsappcrm/contracts by exactly one '
    'label — `created` is the pre-provisioning state, which no customer-facing response reports.';
