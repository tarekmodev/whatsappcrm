-- Reverses `20260822140000_plans_key_format`.
--
-- The constraint goes; the keys repaired by section 1 of the forward file stay
-- repaired. That asymmetry is deliberate and it is not lossy in any way that
-- matters: the old values were strings the published contract refuses, the
-- rename was recorded as a NOTICE in the forward run, and restoring them would
-- put the billing page back into the outage this migration exists to end.
--
-- Guarded, so reverting twice is a no-op.

ALTER TABLE "public"."plans"
    DROP CONSTRAINT IF EXISTS "plans_key_format";

COMMENT ON COLUMN "public"."plans"."key" IS NULL;
