-- One active ticket per contact, and something to allocate ticket numbers with
-- (TAR-74, implementing TAR-73 decisions 2 and 3).
--
-- Two changes, and neither is a column change to `tickets`:
--
--   1. `tickets_one_active_per_contact` — a partial unique index that makes a
--      second active ticket for a contact impossible, not merely unlikely.
--   2. `ticket_counters` — the per-tenant ticket-number allocator, plus the RLS
--      it needs to be a tenant-scoped table like every other one.
--
-- Read `docs/architecture/0003-ticket-auto-linking-contract.md` for why each
-- rejected alternative was rejected. This file records only what is being done
-- and what it costs.
--
-- ---------------------------------------------------------------------------
-- 1. The predicate is `status IN ('open','pending')`, not `status = 'open'`
-- ---------------------------------------------------------------------------
--
-- TAR-74's original text said `open` alone. TAR-73 amended it, and the
-- amendment is the whole point: `pending` means waiting on the customer — it
-- pauses SLA timers rather than ending the thread. A `pending` ticket is still
-- that contact's live ticket, so indexing on `open` alone would hand them a
-- duplicate on their very next message, which is the exact defect TAR-21 exists
-- to prevent. `resolved` and `closed` stay terminal: a customer writing back
-- after resolution gets a new ticket (open question 1 in 0003 — deliberate, and
-- revisable by widening this predicate).
--
-- **`contact_id` stays nullable, and that is load-bearing.** Postgres does not
-- collide NULLs in a unique index, which is what lets TAR-25 create a manual
-- ticket with no contact without conflicting with anything. Do not "tidy" the
-- column to `NOT NULL`.
--
-- `tenant_id` leads the index (schema conventions, rule 3), so a conflict can
-- never be caused by another tenant's row. A unique index is not RLS-aware;
-- leading with `tenant_id` is what makes that irrelevant here.
--
-- **Not CONCURRENTLY, deliberately.** Prisma runs a migration inside one
-- transaction and Postgres forbids `CREATE INDEX CONCURRENTLY` there. `tickets`
-- has no rows in any environment this will be applied to, so a plain
-- `CREATE UNIQUE INDEX` takes an ACCESS EXCLUSIVE lock on an empty table for
-- roughly no time and is the correct choice. If it ever has to reach a
-- populated `tickets`, this statement belongs in an out-of-band step built
-- `CONCURRENTLY` — and the guard below has to be cleared first, because a
-- concurrent build against existing duplicates fails and leaves an `INVALID`
-- index behind.
--
-- **Prisma cannot express this index**, so `schema.prisma` does not contain it.
-- Prisma's Postgres describer skips indexes with a predicate, so `migrate dev`
-- proposes neither to create nor to drop it and this is not drift. The
-- consequence worth knowing: nothing regenerates it from the schema alone.
-- `src/prisma/ticket-active-uniqueness.int-spec.ts` fails if it is missing.
--
-- ---------------------------------------------------------------------------
-- 2. `ticket_counters`
-- ---------------------------------------------------------------------------
--
-- `tickets.number` is `NOT NULL` with `UNIQUE (tenant_id, number)` and no
-- default, so until something allocates a number TAR-75 cannot insert a ticket
-- at all. One row per tenant, created lazily by the first ticket rather than at
-- provisioning, so TAR-50 needs no change.
--
-- `updated_at` carries `DEFAULT now()`, unlike every other table here. TAR-73's
-- allocator is a raw upsert whose column list is `(tenant_id, next_number)`;
-- without the default that statement violates `NOT NULL` and ticket creation is
-- impossible. Prisma's `@updatedAt` still overrides it on any client write.
-- TAR-75 should also set `updated_at = now()` in the `DO UPDATE` branch —
-- Postgres does not refresh a default on update, so the column otherwise
-- records when the tenant's counter was *created*, not last used.
--
-- It is tenant-scoped, so it gets `ENABLE` / `FORCE ROW LEVEL SECURITY` and the
-- same `tenant_isolation` policy TAR-48 attached to the other 33 tables, in
-- this migration rather than a later one.
--
-- ⚠️ **Re-run `pnpm db:roles` after applying this, or `ticket_counters` is
-- unreachable.** Since TAR-95 the app role is deliberately excluded from the
-- schema's default privileges, so it holds *no* privilege on a table
-- `app-roles.sql` has not seen — the grant waits for the policy rather than
-- arriving ahead of it. The `system_unrestricted` policy is created by the same
-- run. `verify-tenant-isolation.sql` derives its table list from the catalog and
-- fails by name until both are in place; that is the safety net working, not an
-- obstacle. CI's Database job already runs the two in that order.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. `tickets` is empty in every environment today,
--                so the index build reads nothing, and `ticket_counters` is a
--                CREATE TABLE.
--   Locks        ACCESS EXCLUSIVE on `tickets` for the index build and the
--                guard's FORCE toggle, and on `tenants` briefly for the foreign
--                key. Prisma holds every lock until the last statement commits.
--   Blocking     `lock_timeout` caps the wait at three seconds, so a
--                long-running transaction holding a conflicting lock aborts this
--                migration cleanly instead of queueing ahead of every new query.
--                Re-run once it clears.
--   Write cost   One extra index on `tickets`, maintained only for rows in
--                `open`/`pending` — a resolved ticket leaves the index instead
--                of sitting in it. The read it serves ("is there an active
--                ticket for this contact?", once per inbound message) is a
--                single-row index lookup on the same index.
--   Data loss    None. Both changes are additive, and the guard refuses to run
--                rather than let the index build report a bare unique violation.
--   Rollback     `down.sql` beside this file. Fully reversible; the only thing
--                it discards is the contents of `ticket_counters`, which is a
--                high-water mark, not history. See that file.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Guard. The index build fails on pre-existing duplicates, which is the right
-- failure — but Postgres reports it as a bare unique violation naming one row.
-- This names the contacts instead, and refuses before anything is altered.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    duplicate_contacts bigint;
BEGIN
    -- The migration owner is NOT exempt from FORCE ROW LEVEL SECURITY and no
    -- `app.tenant_id` is set here, so a plain count reads zero on a full table —
    -- the guard would wave through exactly the case it exists to stop. Counting
    -- with the policy suspended is the only reading that means anything. Same
    -- idiom and same reasoning as TAR-52's and TAR-80's guards.
    --
    -- Safe inline: DDL is transactional, this migration holds ACCESS EXCLUSIVE
    -- on `tickets` for its whole duration so no other session can read it while
    -- FORCE is off, and an abort — including the RAISE below — rolls the toggle
    -- back with everything else.
    EXECUTE 'ALTER TABLE "public"."tickets" NO FORCE ROW LEVEL SECURITY';

    SELECT count(*) INTO duplicate_contacts FROM (
        SELECT "tenant_id", "contact_id"
        FROM "public"."tickets"
        WHERE "contact_id" IS NOT NULL
          AND "status" IN ('open', 'pending')
        GROUP BY "tenant_id", "contact_id"
        HAVING count(*) > 1
    ) AS clashing;

    EXECUTE 'ALTER TABLE "public"."tickets" FORCE ROW LEVEL SECURITY';

    IF duplicate_contacts > 0 THEN
        RAISE EXCEPTION
            'TAR-74 refuses to run: % contact(s) already hold more than one open or pending ticket',
            duplicate_contacts
            USING HINT =
                'Building tickets_one_active_per_contact over those rows cannot succeed. '
                'List them with SELECT tenant_id, contact_id, count(*) FROM tickets WHERE '
                'contact_id IS NOT NULL AND status IN (''open'',''pending'') GROUP BY 1, 2 '
                'HAVING count(*) > 1 — then merge or resolve the duplicates in a separate '
                'migration and re-run this one. Do not widen the predicate to make it pass.';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. The one-active-ticket-per-contact index.
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE UNIQUE INDEX "tickets_one_active_per_contact"
    ON "public"."tickets" ("tenant_id", "contact_id")
    WHERE "status" IN ('open', 'pending');

-- ---------------------------------------------------------------------------
-- 2. `ticket_counters`, the ticket-number allocator.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "public"."ticket_counters" (
    "tenant_id" UUID NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "ticket_counters_pkey" PRIMARY KEY ("tenant_id")
);

-- AddForeignKey
ALTER TABLE "public"."ticket_counters"
    ADD CONSTRAINT "ticket_counters_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. RLS on the new table. Same predicate, same reasoning, same shape as the
-- other 33 in 20260810140000_tenant_isolation_rls — see that file's header for
-- why it is written this way. Role-agnostic (`TO PUBLIC`), so this applies to a
-- cluster where the application roles do not exist yet.
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."ticket_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ticket_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "public"."ticket_counters"
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
