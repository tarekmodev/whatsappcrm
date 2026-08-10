-- Enables login for the two application roles (TAR-49).
--
--   pnpm db:roles:login                                   # local Docker stack
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v password="$APP_ROLE_PASSWORD" \
--     -f apps/api/prisma/sql/app-roles-login.sql          # any other environment
--
-- `app-roles.sql` creates `whatsappcrm_app` and `whatsappcrm_system` NOLOGIN
-- and explains why it stops there: granting login means handing out a password,
-- and a password does not belong in a file in this repository. This script is
-- the operator step that file describes, written down so it is one command
-- rather than a paragraph someone retypes from memory.
--
-- The password is **required and has no default**. That is the guard: there is
-- no value baked in here that could be set by accident on a real database, and
-- the only committed one lives in `.env.example` beside the Compose stack it
-- belongs to. Deployed environments pass a value from their secret store, and
-- re-running with a new value is how a rotation is applied — `ALTER ROLE` is
-- idempotent and the running pods pick it up when they reconnect.
--
-- Both roles get the same password locally and must not share one anywhere
-- else: `whatsappcrm_system` bypasses tenant isolation, so its credential is
-- the more valuable of the two by a wide margin.

\set ON_ERROR_STOP on

\if :{?password}
\else
\echo 'ERROR: no password given. Re-run with -v password=<value from the secret store>.'
\quit 1
\endif

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsappcrm_app')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsappcrm_system') THEN
        RAISE EXCEPTION 'application roles do not exist — run app-roles.sql first';
    END IF;
END
$$;

ALTER ROLE "whatsappcrm_app" LOGIN PASSWORD :'password';
ALTER ROLE "whatsappcrm_system" LOGIN PASSWORD :'password';

\echo '== app roles: login enabled for whatsappcrm_app and whatsappcrm_system =='
