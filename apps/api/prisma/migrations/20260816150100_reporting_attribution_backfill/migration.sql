-- Backfills the two attribution columns 20260816150000 added (TAR-30, ADR 0010
-- decision 4).
--
-- A separate file from the DDL on purpose. The columns are usable the moment
-- that migration commits; this one reads three tables and could take real time
-- on a populated fleet, and folding it into the DDL would hold ACCESS EXCLUSIVE
-- on `tickets` for the whole pass.
--
-- ---------------------------------------------------------------------------
-- Idempotent, and that is the `IS NULL` in each WHERE
-- ---------------------------------------------------------------------------
--
-- Both statements only ever write a row whose column is still NULL, so running
-- this twice writes nothing the second time, and a resumed run after a crash
-- picks up where it stopped. It also means the backfill can never overwrite an
-- attribution the **live writers** recorded — `SlaTimerService.stampFirstResponse`
-- and `TicketCommandService` — which matters because in a rolling deploy this
-- migration and the new application code are running at the same time. The
-- recorded fact wins over the reconstructed one, always.
--
-- ---------------------------------------------------------------------------
-- Best-effort, and the limits are the point
-- ---------------------------------------------------------------------------
--
-- Neither column can be reconstructed for every ticket, and a ticket whose
-- evidence is missing keeps NULL rather than being attributed to somebody
-- plausible. It then lands in the report's `unattributed` row, where it is
-- visible as unattributed instead of silently redistributed across the team.
--
--   first_response_user_id  The earliest **qualifying** message on the ticket's
--                           own conversation, using exactly the predicate
--                           `stampFirstResponse` uses — outbound, non-null
--                           `sender_user_id` (0006's answer to "does a chatbot
--                           count": no), `sent_at >= tickets.created_at`,
--                           earliest by `(sent_at, id)`. Inherits 0006 risk 3
--                           unchanged: a reply sent on a *second* conversation
--                           for a multi-number tenant is invisible to the stamp
--                           and to this.
--   resolved_by_user_id     The latest `ticket_events` row of type
--                           `status_changed` whose `data->>'to'` is `resolved`,
--                           taking its `actor_user_id`. A resolution written
--                           before that event existed, or performed by
--                           automation (which writes a null actor), has nothing
--                           to read.
--
-- Latest rather than earliest for the resolution: `resolved → open` is refused
-- at v1 so there is at most one such event today, and when a reopen window lands
-- the last resolution is the one `resolved_at` holds.
--
-- ---------------------------------------------------------------------------
-- Why the RLS toggle
-- ---------------------------------------------------------------------------
--
-- `tickets`, `messages` and `ticket_events` are all `FORCE ROW LEVEL SECURITY`,
-- and a migration runs as the table owner — the role FORCE exists to stop
-- exempting. Without the toggle both statements below match zero rows **and
-- report success**, which is the failure mode that looks exactly like "there was
-- nothing to backfill". Same reasoning, same shape and same NOTICE as
-- 20260813140000's backfill.
--
-- Safe inline: DDL is transactional, this migration holds ACCESS EXCLUSIVE on
-- all three tables for its duration so no other session can read them while
-- FORCE is off, and an abort rolls the toggle back with everything else.
--
-- ---------------------------------------------------------------------------
-- Impact and risk
-- ---------------------------------------------------------------------------
--
--   Duration     Milliseconds in every environment this reaches today; the
--                tables hold seed data only. On a populated fleet it is two
--                index-supported correlated lookups per candidate ticket —
--                `messages_tenant_id_conversation_id_sent_at_id_idx` and
--                `ticket_events_tenant_id_ticket_id_created_at_id_idx` both
--                serve theirs. ⚠️ Estimate against the largest tenant before
--                running it there; if it is minutes rather than seconds, run it
--                as a batched out-of-band job instead and leave this file as a
--                no-op — the columns are already usable and the live writers are
--                already filling them.
--   Locks        ACCESS EXCLUSIVE on `tickets`, `messages` and `ticket_events`
--                for the duration (the FORCE toggle is DDL). `lock_timeout`
--                caps the wait at three seconds.
--   Data loss    None. Only NULL columns are written.
--   Rollback     `down.sql` beside this file. It sets both columns back to NULL,
--                which is the state before this ran — and see its header for why
--                that is almost never what you want.

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
    responders bigint;
    resolvers  bigint;
BEGIN
    EXECUTE 'ALTER TABLE "public"."tickets" NO FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."messages" NO FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."ticket_events" NO FORCE ROW LEVEL SECURITY';

    -- A correlated subquery rather than `UPDATE … FROM LATERAL`: Postgres does
    -- not allow a lateral reference to the update target from its own FROM list,
    -- and "earliest by (sent_at, id)" needs one row per ticket rather than a
    -- join that multiplies them.
    UPDATE "public"."tickets" t
       SET "first_response_user_id" = (
           SELECT m."sender_user_id"
             FROM "public"."messages" m
            WHERE m."tenant_id" = t."tenant_id"
              AND m."conversation_id" = t."conversation_id"
              AND m."direction" = 'outbound'
              AND m."sender_user_id" IS NOT NULL
              AND m."sent_at" >= t."created_at"
            ORDER BY m."sent_at" ASC, m."id" ASC
            LIMIT 1
       )
     WHERE t."first_response_at" IS NOT NULL
       AND t."first_response_user_id" IS NULL
       AND t."conversation_id" IS NOT NULL;

    GET DIAGNOSTICS responders = ROW_COUNT;

    UPDATE "public"."tickets" t
       SET "resolved_by_user_id" = (
           SELECT e."actor_user_id"
             FROM "public"."ticket_events" e
            WHERE e."tenant_id" = t."tenant_id"
              AND e."ticket_id" = t."id"
              AND e."type" = 'status_changed'
              AND e."data" ->> 'to' = 'resolved'
              AND e."actor_user_id" IS NOT NULL
            ORDER BY e."created_at" DESC, e."id" DESC
            LIMIT 1
       )
     WHERE t."resolved_at" IS NOT NULL
       AND t."resolved_by_user_id" IS NULL;

    GET DIAGNOSTICS resolvers = ROW_COUNT;

    EXECUTE 'ALTER TABLE "public"."ticket_events" FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."messages" FORCE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "public"."tickets" FORCE ROW LEVEL SECURITY';

    -- Both counts are rows *considered*, not rows attributed: a ticket with no
    -- qualifying evidence is counted here and still holds NULL. Printed because
    -- "the backfill ran and found nothing" and "the backfill was filtered out by
    -- RLS and saw nothing" are indistinguishable in a deploy log otherwise, and
    -- the second is what the toggle above exists to prevent.
    RAISE NOTICE 'TAR-30: considered % ticket(s) for first-response attribution and % for resolution attribution',
        responders, resolvers;
END
$$;
