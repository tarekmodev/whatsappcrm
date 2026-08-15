-- The database gate ADR 0009 decision 2 specifies: `assert_tenant_serviceable`,
-- which admits a suspended tenant (TAR-413 review follow-up, phase 1 of 3).
--
-- ---------------------------------------------------------------------------
-- Why the gate has to widen
-- ---------------------------------------------------------------------------
--
-- **Inbound WhatsApp messages must still be received and stored while a tenant
-- is suspended** (0009 lines 216–223, TAR-36's acceptance criteria, TAR-404's
-- second). `whatsapp-inbound.writer.ts` persists the contact, the conversation
-- and the message inside `$tenantTransaction(...)`, which runs the gate on every
-- `set_config`. With `suspended` refused, that path raises `TN001` before its
-- first write, Meta retries and then drops real customer messages, and
-- `TENANT_STATUS_EFFECTS.suspended.inboundAccepted: true` is unimplementable.
--
-- The alternative 0009 rejects is moving that write to `SystemPrisma` — a
-- *writing* unscoped call site in the highest-volume path in the product.
--
-- The lockout TAR-36 actually asks for is `TenantStatusGuard` at request
-- pipeline stage 4, which is TAR-404's to build. The two gates answer different
-- questions — "may any statement touch this tenant's rows" and "may this
-- principal reach this route right now" — and 0009 says explicitly they must not
-- be collapsed. TAR-403's migration collapsed them into one, which is why this
-- file exists.
--
-- ---------------------------------------------------------------------------
-- Why this is three migrations and not one
-- ---------------------------------------------------------------------------
--
-- Expand → migrate → contract, because the function is called on every request
-- in the product and a rename is not an atomic deploy:
--
--   1. **This file.** Creates `assert_tenant_serviceable` alongside
--      `assert_tenant_active`, which is left exactly as it is. Nothing calls the
--      new function yet, so applying this changes no behaviour at all — it is
--      one new, unreferenced function. It is also therefore safe to apply ahead
--      of the application deploy, which is the ordering `migrate deploy` gives
--      us whether we want it or not.
--   2. **TAR-404's engine PR.** Moves `tenant-scope.extension.ts` — the single
--      call site that matters — and `verify-tenant-isolation.sql`, the specs and
--      `docs/reference/tenancy.md` onto the new name. That deploy is where the
--      behaviour changes, and it can be rolled back by rolling back the
--      application alone.
--   3. **A later contract migration.** `DROP FUNCTION assert_tenant_active`,
--      once nothing references it. Not before: a rollback of step 2 needs the
--      old function still present.
--
-- Step 1 alone is what makes the widening reviewable in isolation. It is also
-- what makes it *revertible* in isolation, which matters here more than usual —
-- see below.
--
-- ---------------------------------------------------------------------------
-- ⚠️ This file is held pending TAR-397's ruling
-- ---------------------------------------------------------------------------
--
-- Whether `suspended` reaches the data layer is the first of the four questions
-- TAR-413 put to the Architect. 0009 merged to `main` before TAR-403 did and
-- says yes; TAR-403's migration says no and names the conflict rather than
-- resolving it. This file implements what the merged ADR says.
--
-- If TAR-397 rules the other way, delete this directory rather than reverting
-- it — it has no dependants until step 2 lands, and step 2 is not open.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. One `CREATE FUNCTION`, one catalog row.
--   Locks        None on any table. No row is read or written.
--   Blocking     None. Nothing holds a lock a `CREATE FUNCTION` waits on.
--   Behaviour    **None, on apply.** The new function has no callers until
--                step 2. `assert_tenant_active` is untouched and keeps refusing
--                `suspended`, so a request behaves exactly as it does today.
--   Rollback     `down.sql` beside this file. No data loss; see the ordering
--                note there.
--
-- ---------------------------------------------------------------------------
-- Re-run `pnpm db:roles` after applying this
-- ---------------------------------------------------------------------------
--
-- The default privilege on a new function is `EXECUTE TO PUBLIC`, which works
-- until somebody applies the routine `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA
-- public FROM PUBLIC` hardening step. `app-roles.sql` is amended in the same
-- commit to state the grant for both gate functions rather than one, for the
-- reason it already gives for `assert_tenant_active`: stating it means that step
-- is survivable.

SET LOCAL lock_timeout = '3s';

-- Identical to `assert_tenant_active` as `20260815130000` left it — same
-- signature, same `STABLE`, same pinned `search_path`, same `TN001`, same
-- refusal of a null, a non-UUID and an unknown id, and the same deliberate
-- inability to tell the caller which of those it was — with one line changed:
-- the allow-list gains `suspended`.
--
--   trialing   Admitted, as today.
--   active     Admitted, as today.
--   past_due   Admitted, as today. Dunning is a banner, not an outage.
--   suspended  **Admitted, and that is the change.** Inbound messages are stored
--              through TenantPrisma under RLS; the HTTP lockout is
--              TenantStatusGuard's job, at a layer that knows which principal is
--              asking and which route it wants.
--   created    Still refused. Provisioning has not finished; the tenant's
--              settings, domain and policies may not exist yet.
--   cancelled  Still refused. Access ended, and the retention window is for
--              recovering data through support, not through the product.
--   deleted    Still refused. A purged tenant is a tombstone.
--
-- Still an allow-list and not a deny-list: a label added to `tenant_status` by a
-- later migration is refused until somebody decides it should not be.
--
-- The message says `TENANT_NOT_SERVICEABLE` where the old one says
-- `TENANT_NOT_ACTIVE`, per 0009 line 211. The **error class and its `kind`
-- discriminator do not change** — `TenantNotActiveError`,
-- `TENANT_NOT_ACTIVE_ERROR`, SQLSTATE `TN001`, reported as
-- `subscription_inactive` — so `prisma.errors.ts` and `identity.http.ts` need no
-- edit in step 2. `prisma.errors.ts` discriminates on the SQLSTATE, not on the
-- message text; the string is for the operator reading the log.
CREATE OR REPLACE FUNCTION "public"."assert_tenant_serviceable"(tenant_id text)
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $$
DECLARE
    -- Not named `tenant_status`: that is the enum's own name, and a variable
    -- that shadows a type reads as a mistake even where it resolves.
    current_status "public"."tenant_status";
BEGIN
    IF tenant_id IS NULL OR tenant_id = '' THEN
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: no tenant id was supplied'
            USING ERRCODE = 'TN001';
    END IF;

    IF tenant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        -- Refused as this function's own error rather than left to the cast, so
        -- the application reports it as the refusal it is.
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: tenant id % is not a uuid', tenant_id
            USING ERRCODE = 'TN001';
    END IF;

    SELECT t."status" INTO current_status
    FROM "public"."tenants" t
    WHERE t."id" = tenant_id::uuid;

    IF NOT FOUND THEN
        -- A tenant row that was erased outright, or an id from a session issued
        -- against another database. Same answer as a refused one: the caller
        -- learns nothing about which it was.
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: tenant % does not exist', tenant_id
            USING ERRCODE = 'TN001';
    END IF;

    IF current_status <> ALL (
        ARRAY['trialing', 'active', 'past_due', 'suspended']::"public"."tenant_status"[]
    ) THEN
        RAISE EXCEPTION 'TENANT_NOT_SERVICEABLE: tenant % is %', tenant_id, current_status
            USING ERRCODE = 'TN001';
    END IF;

    RETURN tenant_id;
END;
$$;

COMMENT ON FUNCTION "public"."assert_tenant_serviceable"(text) IS
    'ADR 0009 decision 2, via TAR-413''s follow-up. Returns the tenant id when that tenant''s rows '
    'may be touched at all — trialing, active, past_due or suspended — and raises TN001 otherwise. '
    'Replaces assert_tenant_active as TenantPrisma''s gate. `suspended` is admitted so inbound '
    'WhatsApp messages are still stored for a suspended tenant through TenantPrisma under RLS; '
    'refusing that principal is TenantStatusGuard''s job at request pipeline stage 4, which knows '
    'who is asking. Reads tenants as the calling role, so whatsappcrm_app''s SELECT on that table '
    'is load-bearing.';
