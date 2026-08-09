-- Reverses 20260810120000_baseline_extensions.
--
-- Prisma does not generate down migrations; every migration directory carries a
-- hand-written one, per docs/adr/0001-stack-decision.md (decision 6). This is
-- not applied automatically — see the "Rolling a migration back" section of
-- README.md for how to run it and how to correct Prisma's history afterwards.
--
-- Deliberately NOT `CASCADE`: if a later migration made a column `citext` or
-- built an index on `digest(...)`, this must fail loudly rather than silently
-- destroy that column or index. A failure here means the dependent migration
-- has to be rolled back first.
--
-- Locks: catalog only. No data loss — no user table is touched.

DROP EXTENSION IF EXISTS "citext";

DROP EXTENSION IF EXISTS "pgcrypto";
