-- Reverses 20260816150000_custom_field_shape_guards.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6).
--
-- Drops three CHECK constraints and nothing else. No column, no index, no
-- policy, no row: the up migration was purely additive, so this leaves
-- `contacts` and `custom_field_defs` exactly as 20260816140000 left them.
-- Structurally lossless in both directions, and re-applying the up migration
-- after this succeeds — nothing here can write a value that would fail it.
--
-- **What it costs.** `contacts.custom_fields` goes back to accepting any JSONB,
-- including the two shapes 0002 amendment 10's delete path cannot handle: an
-- array, where `custom_fields - $key` silently removes an *element* instead of
-- a key, and a scalar, where it raises `cannot delete from scalar` and takes
-- the whole delete transaction down with it. `custom_field_defs.options` goes
-- back to accepting a non-array, and `position` to accepting a negative.
--
-- Nothing writes those shapes today — the API validates through
-- `packages/contracts/src/contacts.ts` before every write — so dropping these
-- restores a gap rather than opening a live wound. The gap is exactly the one
-- TAR-478 found: a backfill script, an import, or a `SystemPrisma` call site
-- reaching the column directly has no storage-level guard left.
--
-- No `pnpm db:roles` re-run is needed in either direction. A constraint carries
-- no grants and no policy, and tenant isolation does not depend on any of these
-- — `tenant_isolation` filters through whatever access path remains.
--
-- Nothing to revert in `schema.prisma`: Prisma cannot express a CHECK
-- constraint, so the up migration declared none there and their absence is not
-- drift.
--
-- The explicit transaction is here because, unlike the up migration, this file
-- is applied by hand through `psql`, which is in autocommit.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "public"."custom_field_defs"
    DROP CONSTRAINT IF EXISTS "custom_field_defs_position_non_negative";

ALTER TABLE "public"."custom_field_defs"
    DROP CONSTRAINT IF EXISTS "custom_field_defs_options_is_array";

ALTER TABLE "public"."contacts"
    DROP CONSTRAINT IF EXISTS "contacts_custom_fields_is_object";

COMMIT;
