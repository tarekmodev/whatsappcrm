# Changelog

Notable changes to this project, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been released yet — the package version is `0.0.0` and everything below is on
`main` and unreleased. This file starts at TAR-19; for the scaffold work that preceded it
(TAR-38 monorepo, TAR-40 CI, TAR-42 dev harness, TAR-39 architecture contract), read the git
history.

## [Unreleased]

### Added

- **Tenant provisioning endpoint** — `POST /api/v1/admin/tenants`. Creates a tenant, its
  settings row and its platform subdomain in one transaction; idempotent on `slug`, with
  `201` for a new tenant and `200` for one that already existed.
  [Reference](docs/reference/admin-api.md#post-apiv1admintenants). (TAR-50)
- **Tenant deactivation endpoint** — `POST /api/v1/admin/tenants/{slug}/deactivate`. Revokes
  a tenant's access at the data layer while retaining every row it ever wrote, and records
  the reason in `audit_logs`. Always `200`; reactivation is not here.
  [Reference](docs/reference/admin-api.md#post-apiv1admintenantsslugdeactivate). (TAR-51)
- **The data model** — 37 tables, 34 of them tenant-scoped, plus every index and enum the
  product's first stories need. [Reference](docs/reference/data-model.md). (TAR-47)
- **Tenant isolation in the database** — `FORCE ROW LEVEL SECURITY` and a `tenant_isolation`
  policy on every tenant-scoped table, driven by the `app.tenant_id` transaction setting. No
  setting means zero rows, never unscoped access. (TAR-48)
- **`TenantPrisma` and `SystemPrisma`** — two clients on two database roles. `TenantPrisma`
  sets the isolation setting before every statement and refuses to run without a tenant in
  scope; `SystemPrisma` is a separate client for the five cross-tenant call sites, not a flag.
  [Guide](docs/guides/tenant-scoped-data-access.md). (TAR-49)
- **`$tenantTransaction`** — one transaction, one setting, for any path issuing several
  statements. Batch `$transaction([…])` is not available on `TenantPrisma`. (TAR-49)
- **Application database roles** — `whatsappcrm_app` and `whatsappcrm_system`, created by
  `apps/api/prisma/sql/app-roles.sql` with neither `SUPERUSER` nor `BYPASSRLS`. (TAR-48)
- **`pnpm db:verify:rls`** — proves two tenants cannot see each other's rows, in SQL, as each
  role. Runs in CI on every pull request. (TAR-48)
- **Documentation** — a [style guide](docs/STYLE.md), a [data model
  reference](docs/reference/data-model.md), a [platform admin API
  reference](docs/reference/admin-api.md), and a [guide to tenant-scoped data
  access](docs/guides/tenant-scoped-data-access.md). (TAR-89)

### Changed

- **A tenant may hold more than one WhatsApp Business Account.** `whatsapp_business_accounts`
  is now a first-class table; `whatsapp_accounts` becomes its child, the encrypted access
  token moves to the WABA where Meta issues it, and `message_templates` is re-keyed
  `UNIQUE (tenant_id, whatsapp_business_account_id, name, language)` so one tenant can hold
  the same template approved under two WABAs. Migration
  `20260810160000_whatsapp_business_account_entity` **aborts if either table holds a row** —
  dropping `access_token_encrypted` would destroy the only copy of a live credential.
  [Reference](docs/reference/data-model.md#whatsapp-channel). (TAR-52)
- **The API now needs two database URLs.** `APP_DATABASE_URL` and `SYSTEM_DATABASE_URL` are
  both required at boot, and neither may point at the migration owner: on a managed instance
  the owner is usually a superuser, and a superuser skips row-level security entirely.
  (TAR-49)

### Security

- **A deactivated tenant reaches no data.** `assert_tenant_active` runs inside the same
  statement that sets the isolation setting, so the block covers HTTP handlers, queue
  workers, WebSocket handlers and raw SQL alike, and takes effect on the very next query
  rather than when a cache expires. (TAR-51)
- **The gate's name resolution is pinned.** `assert_tenant_active` carries
  `SET search_path = pg_catalog, public` and its call site is schema-qualified, so a
  connection with an unusual `search_path` cannot change what it resolves. A malformed tenant
  id is now refused as the gate's own `TN001` rather than reported as a server fault.
  (TAR-51)
- **The platform admin surface fails closed.** `/api/v1/admin/*` requires
  `PLATFORM_ADMIN_TOKEN`; leaving it unset refuses every request rather than provisioning for
  anybody who asks. The token is compared in constant time. (TAR-50)

### Operator steps for this change

Applies to every environment, in this order:

1. `pnpm db:migrate:deploy` — applies the six migrations.
2. `pnpm db:roles` — grants the new tables and gives each its `system_unrestricted` policy.
   Required after **any** migration that adds a table or a function; skipping it makes the
   new object invisible to `SystemPrisma`.
3. Set `APP_DATABASE_URL` and `SYSTEM_DATABASE_URL` to the two application roles, not to the
   migration owner.
4. Set `PLATFORM_ADMIN_TOKEN` if this environment provisions tenants. Generate it with
   `openssl rand -base64 48` and keep it in the secret store.
5. `pnpm db:verify:rls` — confirms isolation is enforced before any tenant data exists.
