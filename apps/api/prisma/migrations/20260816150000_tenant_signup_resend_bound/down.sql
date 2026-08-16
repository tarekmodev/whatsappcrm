-- Reverses 20260816150000_tenant_signup_resend_bound.
--
-- Drops the two indexes and the column. Everything here is additive, so the
-- reversal is exact: nothing was renamed or retyped, and no row's data is
-- reinterpreted on the way back.
--
-- ⚠️ Roll the application back first. At this migration's version
-- `TenantSignupService.resend` reads and writes `resend_count`, so dropping the
-- column under a running instance turns every resend into a 500.

DROP INDEX IF EXISTS "public"."tenant_signups_ip_address_created_at_idx";
DROP INDEX IF EXISTS "public"."tenant_signups_email_created_at_idx";

ALTER TABLE "public"."tenant_signups"
    DROP CONSTRAINT IF EXISTS "tenant_signups_resend_count_non_negative";

ALTER TABLE "public"."tenant_signups"
    DROP COLUMN IF EXISTS "resend_count";
