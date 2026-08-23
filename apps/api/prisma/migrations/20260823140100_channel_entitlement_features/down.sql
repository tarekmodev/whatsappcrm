-- Reverses 20260823140100_channel_entitlement_features.
--
-- Exact: the forward migration appended one value to one JSONB array on every
-- row of two tables and changed one column default. This removes that value from
-- the same rows and restores the previous default verbatim.
--
-- ⚠️ **Roll the application back first, and check what is reading these rows.**
-- At this migration's version nothing is: `channel_whatsapp` is a value in an
-- array that no code path consults, because the fail-closed reader that consults
-- it is TAR-821. If this is being run after TAR-821 has shipped, removing the
-- feature **refuses WhatsApp connect for every tenant** — that is the gate doing
-- exactly what it was built to do, on data that no longer says what it should.
-- Roll TAR-821 back too, or leave these rows alone.
--
-- ⚠️ **It removes `channel_whatsapp` from every row, including rows that did not
-- get it from this migration** — a tenant an operator granted it to by hand
-- afterwards is indistinguishable from one the backfill touched, because the
-- forward migration recorded nothing to tell them apart. Recording that would
-- have meant a column on `tenant_entitlements` whose only purpose is to make one
-- rollback tidier, which is a worse trade than this warning. Nothing else in the
-- array is touched: `channel_instagram` and `channel_messenger` were never
-- written here, so a tenant granted either keeps it.
--
-- The array is rebuilt by filtering rather than by index, so the order of every
-- other feature survives and a row that somehow held two copies loses both.

SET LOCAL lock_timeout = '3s';

-- 3 (reverse). The plan catalogue. No FORCE toggle, for the reason the forward
-- migration gives: `plans` carries no `tenant_isolation` policy.
--
-- ⚠️ Reversing this and **not** section 1 would be worse than reversing neither:
-- `copyEntitlements` replaces a tenant's entitlements from its plan on the next
-- subscription event, so a `plans` row without `channel_whatsapp` un-grants it
-- from every tenant on that plan whatever this file did to `tenant_entitlements`.
-- The two statements belong together and this file keeps them together.
DO $$
DECLARE
    reverted bigint;
BEGIN
    UPDATE "public"."plans"
       SET "entitlements" = jsonb_set(
               "entitlements"::jsonb,
               '{features}',
               COALESCE(
                   (
                       SELECT jsonb_agg(feature ORDER BY ordinality)
                         FROM jsonb_array_elements("entitlements"::jsonb -> 'features')
                              WITH ORDINALITY AS elements(feature, ordinality)
                        WHERE feature <> '"channel_whatsapp"'::jsonb
                   ),
                   '[]'::jsonb
               )
           )
     WHERE jsonb_typeof("entitlements"::jsonb -> 'features') = 'array'
       AND "entitlements"::jsonb -> 'features' @> '"channel_whatsapp"'::jsonb;

    GET DIAGNOSTICS reverted = ROW_COUNT;

    RAISE NOTICE 'channel_whatsapp removed from % plan row(s)', reverted;
END
$$;

-- 2 (reverse). 0009's published trial shape as it stood before this migration.
ALTER TABLE "public"."tenant_entitlements"
    ALTER COLUMN "entitlements"
    SET DEFAULT '{"features":["assignment_rules","sla_policies"],"limits":{"seats":3,"conversationsPerPeriod":1000,"whatsappNumbers":1,"teams":2,"knowledgeDocuments":10}}';

-- 1 (reverse). The same FORCE toggle the forward migration needed, and for the
-- same reason: with the `tenant_isolation` policy in force and no `app.tenant_id`
-- set, this UPDATE would match zero rows and report success.
DO $$
DECLARE
    reverted bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."tenant_entitlements" NO FORCE ROW LEVEL SECURITY';

    UPDATE "public"."tenant_entitlements"
       SET "entitlements" = jsonb_set(
               "entitlements"::jsonb,
               '{features}',
               COALESCE(
                   (
                       SELECT jsonb_agg(feature ORDER BY ordinality)
                         FROM jsonb_array_elements("entitlements"::jsonb -> 'features')
                              WITH ORDINALITY AS elements(feature, ordinality)
                        WHERE feature <> '"channel_whatsapp"'::jsonb
                   ),
                   '[]'::jsonb
               )
           )
     WHERE jsonb_typeof("entitlements"::jsonb -> 'features') = 'array'
       AND "entitlements"::jsonb -> 'features' @> '"channel_whatsapp"'::jsonb;

    GET DIAGNOSTICS reverted = ROW_COUNT;

    EXECUTE 'ALTER TABLE "public"."tenant_entitlements" FORCE ROW LEVEL SECURITY';

    RAISE NOTICE 'channel_whatsapp removed from % tenant_entitlements row(s)', reverted;
END
$$;
