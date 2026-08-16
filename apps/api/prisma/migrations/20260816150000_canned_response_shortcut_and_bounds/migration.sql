-- Give `canned_responses` the shape TAR-31's canned responses need (TAR-475,
-- implementing the Data Model section of
-- `docs/architecture/0011-canned-responses-contract.md`).
--
-- **No new table.** TAR-47 shipped `canned_responses` in
-- `20260810130000_initial_data_model` with `UNIQUE (tenant_id, shortcut)` and a
-- `tenant_id` leading every index, and TAR-48 attached `ENABLE`/`FORCE ROW LEVEL
-- SECURITY` plus the `tenant_isolation` policy in
-- `20260810140000_tenant_isolation_rls`. This migration is the deltas 0011 turned
-- out to need, and nothing else:
--
--   1. `shortcut` becomes `citext`, so the existing unique index is
--      case-insensitive.
--   2. Four CHECK constraints: the shortcut grammar, the title bound, the body
--      bound, and the v1 shared-library invariant.
--   3. Nothing for row-level security — `canned_responses` has carried its
--      policy since `20260810140000_tenant_isolation_rls`, so no `pnpm db:roles`
--      re-run is needed after this and `pnpm db:verify:rls` keeps passing.
--   4. Nothing for `canned_responses_tenant_id_created_by_user_id_idx`. 0011
--      recommends dropping it; this migration deliberately keeps it. See the
--      note at the end of this header — it is the one place this file departs
--      from the contract, and it is flagged rather than done silently.
--
-- Read 0011 for why each rejected alternative was rejected. This file records
-- only what is being done and what it costs.
--
-- ---------------------------------------------------------------------------
-- 1. `shortcut` becomes `citext`
-- ---------------------------------------------------------------------------
--
-- `UNIQUE (tenant_id, shortcut)` already exists, and over plain `text` it admits
-- `/Hours` beside `/hours`. Those are two rows an agent cannot tell apart in the
-- composer's picker, and 0011 decision 1 has the console resolving a typed token
-- against its local copy of the set — so a case-insensitive picker match and a
-- case-sensitive uniqueness rule would disagree about which row `/HOURS` means.
--
-- `citext` makes the index itself case-folding, which is the point: the rule
-- lives in the type rather than in every writer's memory. This is the
-- `tenants.slug`, `teams.name` and `assignment_rules.name` precedent
-- (conventions, rule 6), applied to a fourth human-typed unique key.
--
-- `tenant_id` leads the index (conventions, rule 3), so a conflict can never be
-- caused by another tenant's row. A unique index is not RLS-aware; leading with
-- `tenant_id` is what makes that irrelevant here — and it is also what stops the
-- constraint being used as an oracle for another tenant's shortcut namespace
-- (0011, security and access, item 3).
--
-- The unique index is rebuilt by the type change itself; it is not dropped and
-- recreated here.
--
-- ---------------------------------------------------------------------------
-- 2. Four CHECK constraints
-- ---------------------------------------------------------------------------
--
-- `canned_responses_shortcut_format` — `^/[a-z0-9][a-z0-9_-]{0,38}$`.
--
--   The stored value includes the leading `/` (0011 decision 4), matching both
--   what the shipped column comment says and what the agent types. Lowercase, no
--   whitespace and no second `/`, so a shortcut can never contain the trigger
--   character that opens the picker.
--
--   Cast to `text` on purpose. `citext` has no regex operator of its own, so the
--   match is case-*sensitive* — which is what is wanted, because the grammar
--   requires lowercase. The column stays `citext` so `/Hours` and `/hours` still
--   collide on the unique index. Same idiom and same reasoning as
--   `tenant_signups_desired_slug_format`.
--
--   ⚠️ **One deliberate character of difference from 0011's table**, called out
--   so a reviewer does not read it as a transcription slip. The contract's Data
--   Model row writes `{0,39}`, which admits 41 characters; the contract's own
--   published constant, `CANNED_RESPONSE_LIMITS.shortcutLength`, is `40` and its
--   comment says "including the leading `/`". `{0,38}` is the bound that makes
--   the database agree exactly with the constant three readers share. Erring the
--   other way is survivable — Zod would refuse the 41st character before
--   Postgres saw it — but "exactly" is worth more than "harmlessly looser", and
--   a mismatch nobody wrote down is the kind that gets discovered by a 500.
--
-- `canned_responses_title_length` / `canned_responses_body_length` — 1..80 and
-- 1..4096.
--
--   The title is the picker's label, so an empty one is a row nobody can pick.
--   4096 is `SendTextInputSchema.body`'s ceiling, which is what makes "a canned
--   response is always sendable as-is" true rather than hoped for.
--
--   Postgres `length()` counts characters; Zod's `.max()` counts UTF-16 code
--   units. They differ only above the BMP, and they differ in the safe
--   direction: a 4096-emoji body is 8192 units to Zod, which refuses it first.
--   Nothing reaches these constraints that the contract schema would have
--   accepted, so neither can turn a `validation_failed` into a 500.
--
--   Whitespace is not trimmed here, on purpose: `.min(1)` accepts `'   '` and a
--   CHECK on `trim()` would be stricter than the wire schema, which is the one
--   direction that *does* produce a 500. Trimming belongs in the Zod schema
--   TAR-477 writes; flagged there rather than fixed here.
--
-- `canned_responses_is_shared` — `is_shared = true`.
--
--   TAR-31 puts personal (per-agent) responses out of scope and the shipped
--   `is_shared` column is the seam. Enforcing the v1 invariant rather than
--   remembering it means a future personal-responses story has to *drop this
--   constraint* — a visible, reviewable step — instead of discovering that half
--   the read paths never expected a `false`.
--
-- All four added plain, not `NOT VALID` + `VALIDATE`. The table is empty in
-- every environment this can reach, so the validating scan reads nothing and the
-- two-step buys only a second migration. If this ever has to reach a populated
-- `canned_responses`, split each one: `ADD CONSTRAINT … NOT VALID` (a catalog
-- change, SHARE ROW EXCLUSIVE, instant) then `VALIDATE CONSTRAINT` in its own
-- transaction, which scans under a lock that does not block reads or writes.
--
-- **Prisma cannot express a CHECK constraint** and its describer does not report
-- one, so `schema.prisma` does not contain any of these and `migrate dev`
-- proposes neither to create nor to drop them — this is not drift. The
-- consequence worth knowing is the one `tickets_one_active_per_contact` and
-- `assignment_rules_active_has_one_target` already carry: nothing regenerates
-- them from the schema alone. `src/prisma/canned-response-schema.int-spec.ts`
-- fails if any of them is missing.
--
-- ---------------------------------------------------------------------------
-- 4. Why `canned_responses_tenant_id_created_by_user_id_idx` stays
-- ---------------------------------------------------------------------------
--
-- 0011 recommends dropping it as "write amplification on every insert for a
-- query nobody makes". The first half is right and the second half is
-- incomplete: **no application query reads by creator, but the composite foreign
-- key does.**
--
-- `created_by_user_id` is half of `(tenant_id, created_by_user_id) REFERENCES
-- users (tenant_id, id) ON DELETE NO ACTION`. Deleting a `users` row makes
-- Postgres run its referential-integrity check against the referencing side —
-- `SELECT 1 FROM canned_responses WHERE tenant_id = $1 AND created_by_user_id =
-- $2 FOR KEY SHARE` — once per deleted row. Postgres does not index the
-- referencing side of a foreign key for you. Without this index that check is a
-- sequential scan of the whole table, per user.
--
-- That path is real. Removing one user is a status change, not a delete
-- (conventions, rule 4, and `users.service.ts`), so it never fires there — but
-- the tenant purge TAR-397 owns deletes a tenant's rows, and `users` and
-- `canned_responses` both cascade from `tenants`. Purging a tenant with U users
-- would read U × (every canned response in the table, all tenants) rows instead
-- of U index probes.
--
-- What dropping it would actually save is set by 0011's own access-pattern
-- table: writes to this table happen "a few times a month", by hand, by a
-- supervisor. One index entry per such write is not a cost worth naming. So the
-- trade is a negligible, measured-in-months write saving against a sequential
-- scan on the purge path, and the index stays.
--
-- Re-open if TAR-397 lands a purge that deletes `canned_responses` before
-- `users` in an explicit order rather than by cascade, or if the foreign key
-- itself is ever removed — at that point nothing reads these columns together
-- and the drop becomes free. Recorded here so that is a decision someone makes,
-- not a line that quietly reappeared.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds. `canned_responses` is empty in every environment
--                this can reach, so the type change's table rewrite copies no
--                rows, the unique index rebuild reads nothing, and all four
--                CHECKs validate nothing.
--   Locks        ACCESS EXCLUSIVE on `canned_responses` for the whole file —
--                `ALTER COLUMN … TYPE` rewrites the table and the four
--                `ADD CONSTRAINT`s are DDL on it. Prisma holds every lock until
--                the last statement commits. No lock is taken on `users` or
--                `tenants`: no foreign key is added or altered.
--   Blocking     `lock_timeout` caps the wait at three seconds, so a
--                long-running transaction holding a conflicting lock aborts this
--                migration cleanly instead of queueing ahead of every new query.
--                Re-run once it clears.
--                On a populated table the rewrite would block reads as well as
--                writes for its duration (0011, open question 7) — see the note
--                under 2 for how to split this file if that day comes.
--   Write cost   One index entry unchanged (nothing is added or dropped) plus
--                four CHECK evaluations per insert or update, which are a regex
--                and three comparisons against values already in memory.
--   Data loss    None. Every statement is a type widening or a constraint;
--                nothing is dropped and no column is removed.
--   Rollback     `down.sql` beside this file. Structurally exact and lossless —
--                unlike TAR-285's, this migration destroys nothing to undo.

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Guards. Every change below fails on pre-existing bad data, which is the right
-- failure — but Postgres reports each as a bare violation naming one row. These
-- name the count instead, and refuse before anything is altered.
--
-- The migration owner is NOT exempt from FORCE ROW LEVEL SECURITY and no
-- `app.tenant_id` is set here, so a plain count reads zero on a full table — the
-- guard would wave through exactly the case it exists to stop. Counting with the
-- policy suspended is the only reading that means anything. Same idiom and same
-- reasoning as TAR-52's, TAR-74's, TAR-80's and TAR-285's guards.
--
-- Safe inline: DDL is transactional, this migration holds ACCESS EXCLUSIVE on
-- `canned_responses` for its whole duration so no other session can read it
-- while FORCE is off, and an abort — including the RAISEs below — rolls the
-- toggle back with everything else.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    clashing_shortcuts bigint;
    malformed_shortcuts bigint;
    out_of_bounds bigint;
    personal_rows bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."canned_responses" NO FORCE ROW LEVEL SECURITY';

    SELECT count(*) INTO clashing_shortcuts FROM (
        SELECT "tenant_id", lower("shortcut") AS folded
        FROM "public"."canned_responses"
        GROUP BY "tenant_id", lower("shortcut")
        HAVING count(*) > 1
    ) AS clashing;

    SELECT count(*) INTO malformed_shortcuts
    FROM "public"."canned_responses"
    WHERE "shortcut" !~ '^/[a-z0-9][a-z0-9_-]{0,38}$';

    SELECT count(*) INTO out_of_bounds
    FROM "public"."canned_responses"
    WHERE length("title") NOT BETWEEN 1 AND 80
       OR length("body") NOT BETWEEN 1 AND 4096;

    SELECT count(*) INTO personal_rows
    FROM "public"."canned_responses"
    WHERE NOT "is_shared";

    EXECUTE 'ALTER TABLE "public"."canned_responses" FORCE ROW LEVEL SECURITY';

    IF clashing_shortcuts > 0 THEN
        RAISE EXCEPTION
            'TAR-475 refuses to run: % shortcut(s) differ only by case within a tenant',
            clashing_shortcuts
            USING HINT =
                'Rebuilding canned_responses_tenant_id_shortcut_key over those rows cannot '
                'succeed once shortcut is citext. List them with SELECT tenant_id, '
                'lower(shortcut), count(*) FROM canned_responses GROUP BY 1, 2 HAVING '
                'count(*) > 1 — then rename the duplicates in a separate migration and '
                're-run this one. Do not drop the unique index to make it pass.';
    END IF;

    IF malformed_shortcuts > 0 THEN
        RAISE EXCEPTION
            'TAR-475 refuses to run: % shortcut(s) do not match the published grammar',
            malformed_shortcuts
            USING HINT =
                'The composer opens its picker on "/" and matches the rest of the token, so '
                'a shortcut without a leading slash is unreachable and one containing a '
                'second slash is ambiguous. List them with SELECT id, tenant_id, shortcut '
                'FROM canned_responses WHERE shortcut !~ ''^/[a-z0-9][a-z0-9_-]{0,38}$'' — '
                'then correct them in a separate migration and re-run this one.';
    END IF;

    IF out_of_bounds > 0 THEN
        RAISE EXCEPTION
            'TAR-475 refuses to run: % row(s) have a title or body outside the published bounds',
            out_of_bounds
            USING HINT =
                'A row with an empty title cannot be picked, and a body over 4096 characters '
                'cannot be sent as-is because that is SendTextInputSchema.body''s ceiling. '
                'List them with SELECT id, tenant_id, length(title), length(body) FROM '
                'canned_responses WHERE length(title) NOT BETWEEN 1 AND 80 OR length(body) '
                'NOT BETWEEN 1 AND 4096 — then correct them and re-run this one.';
    END IF;

    IF personal_rows > 0 THEN
        RAISE EXCEPTION
            'TAR-475 refuses to run: % row(s) are not shared, which v1 has no reader for',
            personal_rows
            USING HINT =
                'TAR-31 scopes canned responses to a tenant-shared library, so every read '
                'path assumes is_shared. Rows with is_shared = false are invisible to the '
                'feature being built. List them with SELECT id, tenant_id, shortcut FROM '
                'canned_responses WHERE NOT is_shared — then decide whether they are shared '
                'or should be removed, and re-run this one. If personal responses are now '
                'in scope, that is a story that drops this constraint, not a reason to skip '
                'adding it (0011, open question 3).';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. `shortcut` becomes `citext`. The unique index is rebuilt by the rewrite.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "public"."canned_responses"
    ALTER COLUMN "shortcut" SET DATA TYPE CITEXT USING "shortcut"::CITEXT;

-- ---------------------------------------------------------------------------
-- 2. The four bounds. See the header for why each one is in the database.
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."canned_responses"
    ADD CONSTRAINT "canned_responses_shortcut_format"
    CHECK ("shortcut"::text ~ '^/[a-z0-9][a-z0-9_-]{0,38}$');

ALTER TABLE "public"."canned_responses"
    ADD CONSTRAINT "canned_responses_title_length"
    CHECK (length("title") BETWEEN 1 AND 80);

ALTER TABLE "public"."canned_responses"
    ADD CONSTRAINT "canned_responses_body_length"
    CHECK (length("body") BETWEEN 1 AND 4096);

ALTER TABLE "public"."canned_responses"
    ADD CONSTRAINT "canned_responses_is_shared"
    CHECK ("is_shared");

-- ---------------------------------------------------------------------------
-- Column comments, so the grammar is readable from `\d+ canned_responses` and
-- not only from this file.
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN "public"."canned_responses"."shortcut" IS
    'TAR-475. What an agent types to expand the response, leading "/" included, '
    'e.g. "/refund". citext, so it is unique per tenant case-insensitively.';

COMMENT ON COLUMN "public"."canned_responses"."is_shared" IS
    'TAR-475. Always true at v1: TAR-31 scopes canned responses to a '
    'tenant-shared library. canned_responses_is_shared is the seam a future '
    'personal-responses story drops.';
