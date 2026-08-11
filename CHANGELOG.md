# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been released yet: the package version is `0.0.0` and every entry below sits
under **Unreleased**. Entries are grouped as **Added**, **Changed**, **Fixed**, **Removed**
and **Security**, and each carries the story that delivered it. This file starts here, so
the first section covers everything on `main` to date rather than only the most recent
change.

## [Unreleased]

### Added

- **Login and the session lifecycle** — `POST /api/v1/auth/login` authenticates an email
  and password against the tenant the request `Host` resolves to and issues an opaque
  256-bit session in a `__Host-wac_session` cookie; `GET /api/v1/auth/session` reads the
  caller back and is also the refresh, because the idle window slides on use rather than
  through a second endpoint; `POST /api/v1/auth/logout`, `GET /api/v1/auth/sessions` and
  `DELETE /api/v1/auth/sessions/{id}` cover signing out and dropping one device. Every
  authenticated request now resolves its principal from that cookie —
  `SessionPrincipalSource` is bound to `PRINCIPAL_SOURCE`, the seam TAR-22 built its
  guards around, so `AUTH_STUB_ENABLED` is no longer the only way to be somebody.
  Passwords are Argon2id at `AUTH_POLICY`'s parameters, re-hashed in place when those are
  raised; ten consecutive failures lock the account for fifteen minutes, and the response
  is `rate_limited` rather than a code that would confirm the address exists. Sessions
  resolve through a shared Redis cache with a 60-second TTL and fall back to Postgres when
  it is absent. New: `SESSION_COOKIE_SECURE` (the API refuses to boot with it off under
  `NODE_ENV=production`). (TAR-56)
- **Password reset and password change** — `POST /api/v1/auth/password-reset` issues a
  single-use, 60-minute link and answers 204 unconditionally, so it cannot be used to ask
  whether an address has an account; `POST /api/v1/auth/password-reset/confirm` redeems it
  once, sets the new password and revokes **every** session for that account;
  `POST /api/v1/auth/password` changes a known password and revokes every session
  **except the caller's own**. A dead link answers `token_invalid` (410) with the reason,
  so the reset screen can offer a new one rather than a 404. Single-use is a conditional
  `UPDATE … RETURNING` and every expiry is judged by the database's `now()`, so two
  simultaneous redemptions cannot both win and a skewed node clock cannot revive a spent
  link. Both flows hash through the same `PasswordService` login uses; the token itself is
  never stored, only its SHA-256. `IdentityModule` also carries the `MAILER` seam —
  `ConsoleMailer` renders the link to the log outside production, and a deployed
  environment gets `UndeliverableMailer` until TAR-41 wires a provider. New optional
  `APP_LINK_SCHEME` (default `https`) fixes the scheme on emailed links. (TAR-57)
- **Backup coverage and a restore drill** — `docs/runbooks/backups.md` records what
  Render's continuous backup and point-in-time recovery actually cover per
  environment, how to restore, and the cadence for proving it. `pnpm db:restore-drill`
  dumps a database, restores it into a scratch target and diffs the two on eleven
  dimensions — including the RLS flags and policy predicates, which a silently
  degraded restore loses without anything else noticing. First drill run and
  recorded 2026-08-11. (TAR-43)
- **Media pipeline** — inbound WhatsApp media is downloaded from Meta and re-hosted, and
  `POST /api/v1/media` accepts a multipart upload and returns a `mediaId` a send can name.
  Reads are `GET /api/v1/media/{id}` and `GET /api/v1/media/{id}/content`, both
  session-authenticated and tenant-scoped. A new `media_objects` table holds one row per
  stored binary; `message_attachments` becomes the join between a message and one, and
  gains `download_state` so the inbox can render the interval in which a message exists and
  its picture does not. Storage is behind a `MediaStorage` port with a filesystem adapter —
  **`MEDIA_STORAGE_ROOT` must be a durable shared volume** until an object-store adapter
  lands with TAR-41. Media types and size ceilings are Meta's own, published in
  `WHATSAPP_MEDIA_LIMITS` and enforced server-side: an unsupported type is
  `validation_failed`, an oversize one `payload_too_large`. Ruled as
  [amendment 3](docs/architecture/0002-architecture-and-api-contract.md#amendment-3--media-tar-20e).
  (TAR-20e)
- **Demo seed data** — `pnpm db:seed` loads two tenants (`northwind.app.localhost` and
  `southwind.app.localhost`) with agents across all three roles, teams, WhatsApp business
  accounts and numbers, message templates, contacts, conversations, messages, an attachment
  with the media object behind it, tickets and a subscription. Ticket events use
  `TICKET_EVENT_TYPES`, so a seeded timeline reads the same as one the app wrote.
  Written through `TenantPrisma` as `whatsappcrm_app` under row-level
  security, with tenants created by `TenantProvisioningService` rather than by hand, so a
  seed that finishes proves the application role can read and write the data. Re-runnable:
  it deletes its own two slugs and nothing else, and refuses to run under
  `NODE_ENV=production` without `--force`. The second tenant exists so that a dropped
  tenant predicate is visible rather than theoretical. The Database CI job runs it. (TAR-46)
- **Auth schema and tenant-scoped migrations** — `password_reset_tokens` (single-use,
  60-minute, hashed) and `invite_teams`, both with `FORCE ROW LEVEL SECURITY` and a
  `tenant_isolation` policy; durable lockout columns on `users`; `absolute_expires_at` and
  `revoked_reason` on `sessions`; `revoked_at` on `invites` and a partial unique index that
  makes two live invites for one address impossible. No credential is stored in a form
  anything can reverse — every token is a SHA-256 hash, and passwords stay Argon2id.
  Reversible: `down.sql` restores the previous schema exactly. (TAR-54)
- **WhatsApp Business Account connection** — `POST /api/v1/admin/tenants/{slug}/whatsapp/business-accounts`
  and `.../{wabaId}/template-sync`, behind the same platform admin guard, plus the Meta
  Cloud API client, the credential resolver and the sender service. (TAR-66)
- **Template list endpoint** — `GET /api/v1/message-templates`, approved templates only,
  keyset-paginated, with the `(tenant_id, status, name, language, id)` index that serves
  it. (TAR-20a)
- **Ticket auto-create/attach service** — `TicketsModule`, providing the `TICKET_LINKER`
  implementation of TAR-73's contract. An inbound message from a contact with no active
  ticket opens one; every later message attaches to that ticket, reopening it if the
  customer was replying to a `pending` one. Concurrent messages resolve to a single ticket
  through `tickets_one_active_per_contact` rather than an application check, and the losing
  call attaches to the winner instead of reporting a conflict. Nothing calls it on
  production traffic yet — TAR-77 wires it to the inbound pipeline. (TAR-75)
- **Ticket auto-linking contract** — `docs/architecture/0003-ticket-auto-linking-contract.md`
  and `packages/contracts/src/ticket-linking.ts`. (TAR-73)
- **RBAC permission matrix** — `docs/architecture/0004-rbac-permission-matrix.md`, fixing
  the agent, supervisor and admin permission sets. (TAR-79)
- **Tenant provisioning endpoint** — `POST /api/v1/admin/tenants`. Creates the tenant, its
  settings and its platform subdomain in one transaction. Idempotent on `slug`: `201` when
  the call provisioned the tenant, `200` when it already existed, with the same body either
  way. Authenticated by `PLATFORM_ADMIN_TOKEN`; with that variable unset the whole
  `/api/v1/admin/*` surface refuses every request. (TAR-50)
- **Tenant deactivation endpoint** — `POST /api/v1/admin/tenants/{slug}/deactivate`. Revokes
  a tenant's access and retains all of its data. Idempotent, always `200`, `404` on an
  unknown slug. Writes one `audit_logs` entry (`tenant.deactivated`) in the same transaction
  as the status change, stamped from the database clock so the two agree. (TAR-51)
- **Deactivation gate in the database** — `public.assert_tenant_active(text)`, called by
  every `TenantPrisma` statement on its way to setting the row-level security GUC. A
  non-`active` tenant never sets the GUC, so the block covers HTTP handlers, queue workers,
  WebSocket handlers and raw SQL alike, and is in force from the instant deactivation
  commits. (TAR-51)
- **`TenantPrisma` and `SystemPrisma`** — two Prisma clients on two database roles, plus the
  client extension that sets `app.tenant_id` per transaction and the `$tenantTransaction`
  helper for multi-statement work. A query with no tenant in scope throws before anything is
  sent. (TAR-49)
- **Tenant isolation at the data layer** — `FORCE ROW LEVEL SECURITY` and one
  `tenant_isolation` policy on every tenant-scoped table; the non-`BYPASSRLS` application
  role; and `pnpm db:verify:rls`, which proves two tenants cannot see each other's rows and
  is derived from the catalog rather than from a list. (TAR-48)
- **The initial data model** — 37 Prisma models covering tenancy, identity, the WhatsApp
  channel, contacts, the inbox, tickets, assignment, SLA, workflows, AI, billing and platform
  plumbing, with the migration that creates them. (TAR-47)
- **`whatsapp_business_accounts`** — WhatsApp Business Accounts (WABAs) modelled as a
  first-class entity, so a tenant may hold more than one. (TAR-52)
- **Local development harness** — Docker Compose stack for PostgreSQL 17 and Redis 7, the
  Prisma runner, the application-role scripts and the documented setup steps. (TAR-42)
- **Continuous integration** — Lint, Type-check, Test and Database jobs on every push to
  `main` and every pull request; branch protection on the first three. (TAR-40)
- **Published architecture and API contract** — module boundaries, tenant resolution, the
  endpoint surface, webhook ingestion, and the billing and usage ports.
  (TAR-39, amended by TAR-20a)
- **Documentation** — a data model reference, a platform admin API reference, the tenant
  isolation contract, and the documentation style guide this file follows. (TAR-89)

### Changed

- **Revoking a session marks it revoked rather than deleting the row.** A role, status or
  team change — and an admin suspending or removing an agent — now writes `revoked_at` and
  `revoked_reason` instead of `DELETE`ing, and purges the Redis principal cache on both
  sides of the commit. Access still ends at the commit: every read path filters
  `revoked_at IS NULL`, and the second purge closes the window in which an in-flight
  request could repopulate the cache from the not-yet-revoked row. What it buys is a trail
  that can say _why_ every session for one person died at 14:03, and a device list that
  stops showing a session that is gone. Revoked and expired rows are not yet swept — see
  the follow-up note in TAR-53's failure-modes table. (TAR-56)
- **`conversations.last_message_at` is `NOT NULL`, defaulting to the row's insert time.**
  It leads all three inbox keyset indexes, and PostgreSQL orders NULLs first under `DESC`,
  so a message-less conversation pinned itself to page one and the resume predicate
  evaluated to NULL — silently dropping every row after that cursor. (TAR-92)
- **The role vocabulary is three values, not four.** `user_role.owner` is dropped: no code
  wrote it and `TenantRoleSchema` would have rejected it at the serializer. Done while
  `users` and `invites` were empty everywhere, because removing an enum value is a type
  swap and a table rewrite while adding one back is an online `ALTER TYPE`. The same change
  adds `users.last_seen_at` and `teams.description`, moves `teams.name` to `citext`, and
  puts sort keys on the four role-scoped inbox and queue indexes. (TAR-80)
- **WhatsApp entities are scoped at three levels, not two.** `whatsapp_accounts` is now a
  phone number belonging to a WABA rather than a row that also stood in for the business.
  `message_templates` is re-keyed from `UNIQUE (tenant_id, name, language)` to
  `UNIQUE (tenant_id, whatsapp_business_account_id, name, language)`, so one tenant can hold
  the same template approved separately under two WABAs. `quality_rating` is added to
  `whatsapp_accounts`, where Meta rates and throttles. Migration
  `20260810160000_whatsapp_business_account_entity` refuses to run against a database with
  any rows in either table, because it drops columns outright; with data present the same
  change has to be redone as expand → backfill → contract. (TAR-52)
- **The API takes two database URLs, not one.** `APP_DATABASE_URL` and
  `SYSTEM_DATABASE_URL`, both required, neither of which may be the migration owner — on a
  managed instance the owner is usually a superuser, and a superuser skips row-level security
  entirely. (TAR-49)
- **`assert_tenant_active` pins its own `SET search_path`** and is called schema-qualified, so
  the gate evaluates identically on every connection rather than depending on the caller's
  `search_path`. (TAR-51)

### Fixed

- **A malformed tenant id is refused as `TN001`, not raised as a cast error.** It previously
  reached the application as SQLSTATE `22P02`, which was reported as a fault rather than as
  the refusal it is. No isolation consequence — the cast raised before `set_config` either
  way, so the GUC was unset and the policies matched nothing. (TAR-51)

### Removed

- **`whatsapp_accounts.access_token_encrypted` and `whatsapp_accounts.waba_id`**, both moved
  to `whatsapp_business_accounts`. Meta issues the access token to the business, so one copy
  per WABA makes a rotation a single-row update instead of an N-row update whose rows can
  drift apart. (TAR-52)

### Security

- **A table no migration has granted is unreachable by `whatsappcrm_app`.** `app-roles.sql`
  no longer leaves `ALTER DEFAULT PRIVILEGES … ON TABLES` pointing at the app role, so a
  migration that adds a tenant-scoped table and forgets its `tenant_isolation` block ships a
  table nobody can read rather than one every tenant can. The grant now waits for the policy
  instead of arriving ahead of it; `pnpm db:roles` — already the documented post-migration
  step — issues it, and `pnpm db:verify:rls` then fails by name if the policy is still
  missing. `whatsappcrm_system` keeps its default privileges: it is the cross-tenant role, and
  a table it cannot reach is a bug rather than a safeguard. `db:verify:rls` creates a
  throwaway table on every run to assert both halves, so the default cannot drift back open
  unnoticed. No behaviour changes for tables that already exist. (TAR-95)
- **The application database role holds neither `SUPERUSER` nor `BYPASSRLS`**, and
  `app-roles.sql` re-asserts that on every run rather than assuming it. `SystemPrisma`'s
  cross-tenant access is a per-table `system_unrestricted` policy rather than the cluster-wide
  `BYPASSRLS` attribute, so it is visible in `pg_policies` and revocable one table at a time.
  (TAR-48)
- **The platform admin token is compared in constant time** after both sides are hashed to a
  fixed length, so neither the token's length nor how far a guess matched is observable. An
  unset token disables the admin surface rather than opening it. (TAR-50)
- **Both application roles are created `NOLOGIN` and without a password.** Granting login is
  an operator step against the environment's secret store; no password, local or otherwise,
  is committed. (TAR-48)
