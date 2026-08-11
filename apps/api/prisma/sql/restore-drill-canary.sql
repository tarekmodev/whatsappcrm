-- Canary rows for the restore drill (TAR-43).
--
-- A restore drill against an empty database proves the schema came back and
-- nothing about the data. This writes the smallest dataset that makes the
-- drill's row-count and content comparison mean something: one tenant and one
-- row in each table that exercises a type the dump/restore path can get wrong —
-- citext, an enum, jsonb, inet, uuid and timestamptz.
--
-- This is NOT seed data. TAR-46 owns the demo dataset a developer works
-- against; if that has been run, the drill already has real rows and this file
-- is unnecessary. Its only job is to keep the drill honest on a database that
-- is migrated but otherwise empty.
--
--   pnpm db:canary          # load it
--   pnpm db:restore-drill   # then drill
--
-- Every id is a fixed UUID and every insert is ON CONFLICT DO NOTHING, so
-- running it twice is a no-op rather than a duplicate-key error. Deliberately
-- no DELETE: a fixture file that can remove rows is a fixture file that can
-- remove the wrong rows.
--
-- Safe on any non-production database. It writes one tenant whose slug is
-- `restore-drill-canary`; nothing else in the platform reads that slug.

\set ON_ERROR_STOP on

BEGIN;

-- Superuser and the table owner both bypass or are subject to RLS depending on
-- FORCE ROW LEVEL SECURITY, and this file is run by the migration owner. Set
-- the GUC the tenant_isolation policy reads so the inserts below satisfy it
-- either way, rather than depending on which role happens to run this.
SET LOCAL app.tenant_id = '00000000-0000-4000-8000-00000000d411';

INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-00000000d411',
  'restore-drill-canary',
  'Restore Drill Canary',
  'active',
  TIMESTAMPTZ '2026-01-01 00:00:00+00',
  TIMESTAMPTZ '2026-01-01 00:00:00+00'
)
ON CONFLICT (id) DO NOTHING;

-- jsonb, and a non-UTC timezone: both survive a custom-format dump only if the
-- restore reads them back with the same encoding assumptions.
INSERT INTO tenant_settings (id, tenant_id, timezone, locale, business_hours, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-00000000d412',
  '00000000-0000-4000-8000-00000000d411',
  'Asia/Riyadh',
  'ar-SA',
  '{"sun": ["09:00", "17:00"], "mon": ["09:00", "17:00"]}'::jsonb,
  TIMESTAMPTZ '2026-01-01 00:00:00+00',
  TIMESTAMPTZ '2026-01-01 00:00:00+00'
)
ON CONFLICT (id) DO NOTHING;

-- citext: the hostname is stored mixed-case on purpose, so a restore that loses
-- the citext extension fails the comparison rather than passing quietly.
INSERT INTO tenant_domains (id, tenant_id, hostname, kind, is_primary, verified_at, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-00000000d413',
  '00000000-0000-4000-8000-00000000d411',
  'Canary.app.localhost',
  'platform',
  true,
  TIMESTAMPTZ '2026-01-01 00:00:00+00',
  TIMESTAMPTZ '2026-01-01 00:00:00+00',
  TIMESTAMPTZ '2026-01-01 00:00:00+00'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, tenant_id, email, name, password_hash, role, status, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-00000000d414',
  '00000000-0000-4000-8000-00000000d411',
  'Canary@Example.test',
  'Drill Canary',
  -- Not a credential: a literal placeholder, and the account cannot be logged
  -- into because no hash produces it.
  'not-a-real-hash',
  'admin',
  'active',
  TIMESTAMPTZ '2026-01-01 00:00:00+00',
  TIMESTAMPTZ '2026-01-01 00:00:00+00'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO whatsapp_business_accounts (id, tenant_id, waba_id, name, verification_status, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-00000000d415',
  '00000000-0000-4000-8000-00000000d411',
  'canary-waba',
  'Canary WABA',
  'verified',
  TIMESTAMPTZ '2026-01-01 00:00:00+00',
  TIMESTAMPTZ '2026-01-01 00:00:00+00'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO whatsapp_accounts (
  id, tenant_id, whatsapp_business_account_id, phone_number_id,
  display_phone_number, verified_name, status, created_at, updated_at
)
VALUES (
  '00000000-0000-4000-8000-00000000d416',
  '00000000-0000-4000-8000-00000000d411',
  '00000000-0000-4000-8000-00000000d415',
  'canary-phone-number-id',
  '+966500000000',
  'Canary',
  'connected',
  TIMESTAMPTZ '2026-01-01 00:00:00+00',
  TIMESTAMPTZ '2026-01-01 00:00:00+00'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO contacts (id, tenant_id, phone_e164, display_name, email, locale, custom_fields, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-00000000d417',
  '00000000-0000-4000-8000-00000000d411',
  '+966511111111',
  'قناري',  -- Non-ASCII on purpose: a dump/restore that mangles the encoding fails here.
  'Contact@Example.test',
  'ar-SA',
  '{"source": "restore-drill"}'::jsonb,
  TIMESTAMPTZ '2026-01-02 08:30:00+00',
  TIMESTAMPTZ '2026-01-02 08:30:00+00'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO conversations (
  id, tenant_id, whatsapp_account_id, contact_id, status,
  assigned_user_id, last_message_at, unread_count, created_at, updated_at
)
VALUES (
  '00000000-0000-4000-8000-00000000d418',
  '00000000-0000-4000-8000-00000000d411',
  '00000000-0000-4000-8000-00000000d416',
  '00000000-0000-4000-8000-00000000d417',
  'open',
  '00000000-0000-4000-8000-00000000d414',
  TIMESTAMPTZ '2026-01-02 08:35:00+00',
  1,
  TIMESTAMPTZ '2026-01-02 08:30:00+00',
  TIMESTAMPTZ '2026-01-02 08:35:00+00'
)
ON CONFLICT (id) DO NOTHING;

-- One message each way, so both enum values on message_direction are present in
-- the data and not only in the type definition.
INSERT INTO messages (
  id, tenant_id, conversation_id, direction, status, content_type, body,
  provider_message_id, sender_user_id, sent_at, created_at, updated_at
)
VALUES
  (
    '00000000-0000-4000-8000-00000000d419',
    '00000000-0000-4000-8000-00000000d411',
    '00000000-0000-4000-8000-00000000d418',
    'inbound',
    'delivered',
    'text',
    'مرحبا — inbound canary',
    'wamid.canary.inbound',
    NULL,
    TIMESTAMPTZ '2026-01-02 08:30:00+00',
    TIMESTAMPTZ '2026-01-02 08:30:00+00',
    TIMESTAMPTZ '2026-01-02 08:30:00+00'
  ),
  (
    '00000000-0000-4000-8000-00000000d41a',
    '00000000-0000-4000-8000-00000000d411',
    '00000000-0000-4000-8000-00000000d418',
    'outbound',
    'read',
    'text',
    'Outbound canary',
    'wamid.canary.outbound',
    '00000000-0000-4000-8000-00000000d414',
    TIMESTAMPTZ '2026-01-02 08:35:00+00',
    TIMESTAMPTZ '2026-01-02 08:35:00+00',
    TIMESTAMPTZ '2026-01-02 08:35:00+00'
  )
ON CONFLICT (id) DO NOTHING;

-- inet, which is the one column type in the schema with a text representation
-- that is not its storage representation.
INSERT INTO audit_logs (id, tenant_id, actor_user_id, action, target_type, target_id, metadata, ip_address, created_at)
VALUES (
  '00000000-0000-4000-8000-00000000d41b',
  '00000000-0000-4000-8000-00000000d411',
  '00000000-0000-4000-8000-00000000d414',
  'restore_drill.canary_loaded',
  'tenant',
  '00000000-0000-4000-8000-00000000d411',
  '{"note": "fixture for the TAR-43 restore drill"}'::jsonb,
  '198.51.100.7'::inet,
  TIMESTAMPTZ '2026-01-02 08:36:00+00'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

SELECT 'restore-drill canary loaded: ' || count(*) || ' tenant row(s) named restore-drill-canary'
  FROM tenants WHERE slug = 'restore-drill-canary';
