-- Baseline migration (TAR-42).
--
-- The first migration in the project. It creates no tables: entities and the
-- tenant-scoping mechanism are TAR-39's, and inventing them here would pre-empt
-- that design. What it does do is give the migration runner a real, verifiable
-- unit of work, and establish the directory shape every later migration copies:
-- `migration.sql` generated or hand-written, `down.sql` hand-written beside it.
--
-- Both extensions ship with the `postgres:17-alpine` image and with Render's
-- managed Postgres, so this applies unchanged in every environment. Neither is
-- load-bearing yet; if TAR-39's model uses neither, drop them with `down.sql`
-- rather than carrying them forever.
--
--   pgcrypto  digest()/crypt()/gen_salt() for any hashing done in SQL.
--             Note gen_random_uuid() is core in PostgreSQL 13+ and does not
--             need this extension.
--   citext    case-insensitive text, for identifiers such as email addresses
--             where 'A@b.com' and 'a@b.com' must collide on a unique index.
--
-- Locks: ACCESS EXCLUSIVE on the catalog only, for the duration of each
-- statement. No user table is touched, so this is effectively instantaneous and
-- blocks nothing.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE EXTENSION IF NOT EXISTS "citext";
