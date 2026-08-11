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

### Security

- **A locked account and an address with no account now answer identically** — the login
  429 was a per-tenant user-enumeration oracle in the shipped configuration.
  `LOGIN_IP_THROTTLE_ENABLED` defaults to off, so `AccountLockedError` was the only thing
  that could produce a 429 on login, and it is reachable only for an `active` account that
  has a password hash: eleven wrong passwords answered 429 for a real address and 401 for
  one with no account, which the identical bodies and the dummy verify did nothing about.
  `LoginThrottleService` gains a third layer keyed by the address that was **typed** —
  `emailfail:{tenantId}:{sha256(email)}` counting and
  `emaillock:{tenantId}:{sha256(email)}` locking — reusing `loginFailureThreshold` and
  `loginLockoutMs` so an unknown address locks on the same attempt, for the same duration,
  and forgets after the same quiet period, with the same code, body and `Retry-After` as a
  real one. Checked before the account lookup, so the two cost the same as well. All three
  of those have to match: threshold and duration were matched from the start, and retention
  is the durable counter's window below. No feature flag: the address comes from the
  request body rather than from a proxy-derived header, and the only account an attacker
  can lock with it is one they can already lock durably. Addresses are hashed — an email is
  PII, and free text from a request body must not reach a Redis key verbatim — and lower-
  cased first, because `users.email` is `citext` and two windows for one account would
  double the allowance for the price of a shift key. Both keys are cleared everywhere
  `failed_login_attempts = 0` is written — a successful sign-in, an admin unlock, a
  completed password reset, a password change and an accepted invite — since a lockout the
  admin cleared but a Redis key still enforces is not an unlock, and a reset that still ends
  at a 429 is not a way back in. It fails open like every other Redis path here, which means
  the oracle is open again while Redis is unreachable; that is stated in the code, in ADR
  0005 and here rather than left to be discovered — and it is the one caveat left, now that
  the entry below has closed the other. (TAR-64 review)
- **The durable lockout counter decays, so a pause cannot reopen that same oracle** —
  `failed_login_attempts` accumulated until one of the five reset paths wrote a zero, while
  the Redis counter beside it simply expired after `loginLockoutMs`. Two counters that lock
  on the same attempt but forget on different clocks are only in step until somebody waits:
  nine wrong passwords, sixteen minutes, and the tenth attempt locked a real account off a
  counter still sitting at nine while the Redis one had restarted at 1 — so the eleventh
  answered 429 for an address with an account and 401 for one without, which is the
  enumeration oracle the entry above closes for the unpaced case. Cheaper still against any
  address whose counter was already warm from its owner's own typos: one request. The count
  is now windowed inside the statement that already writes `last_failed_login_at` — a
  failure more than `loginLockoutMs` after the previous one starts the run again at 1 — so
  the two retentions are the same period by construction rather than two numbers somebody
  keeps equal. No new key, no extra round trip, and no migration: the columns are unchanged.
  An attacker gains nothing, since the cumulative counter re-locked on every multiple and so
  allowed the same ten guesses per period; what changes is that a user who fumbled nine
  times over a year is no longer one attacker request away from being locked out, and that
  the `failedLoginAttempts` an admin reads on `UserResponse.security` is now the current
  window's count rather than an all-time total. (TAR-154)
- **A cached session principal is never written before the revocation index names it** —
  `SessionService.resolve` wrote `sess:{tokenHash}` and then `SADD`ed the hash to the user's
  index as two independent calls, each swallowing its own failure. `purgeUser` deletes only
  what `SMEMBERS` returns, so an entry cached while the `SADD` failed was invisible to every
  revocation path and kept answering for the rest of its 60-second TTL — through a
  suspension, a logout-everywhere, a password reset or a change. With a 500 ms command
  timeout and one retry on the auth Redis client, a brief stall between the two calls is a
  realistic outcome rather than a hypothetical. `SessionCacheService.track` now reports
  whether the index write landed and issues its two commands in one `MULTI` (an `SADD`
  whose `PEXPIRE` never ran left the index with no TTL at all), and both writers — login's
  `publish` and resolution's cache fill — write the principal only when it did. A skipped
  write costs one Postgres read per request; an un-purgeable entry costs a revocation.
  (TAR-64 review)

- **The API trusts a forwarded host only from a caller holding a shared secret** — Render
  routes by `Host` at its edge and tenant domains are attached to the _web_ service, so
  inside the API `request.hostname` is always the API's own host and `HostTenantGuard`
  resolved no tenant at all in any deployed environment, on the browser path through the
  Next.js rewrite as much as on the server-rendered one. The web tier now forwards the host
  it was reached at as `x-edge-host`, and `HostTenantGuard` reads it **only** when
  `x-edge-auth` matches `TRUSTED_PROXY_SECRET` (or `TRUSTED_PROXY_SECRET_PREVIOUS`, so the
  secret rotates without a synchronised two-service deploy) — the same fail-closed,
  timing-safe comparison `PlatformAdminGuard` already used, now shared by both. Both header
  names are private: the standard `x-forwarded-host` is never read, because the web-to-API
  hop is a public one and every proxy on it is entitled to rewrite `x-forwarded-*`. Without
  a valid secret the header is not read at all and the fallback is `Host`, never the value
  the caller supplied; a multi-valued `x-edge-host` is refused outright rather than
  resolved to its leftmost element. Express `trust proxy` stays off, deliberately — the
  gate is explicit code, not a framework-wide flag that would honour the header ungated.
  The API refuses to **boot** under `NODE_ENV=production` without the secret, because an
  API that cannot resolve a tenant serves nothing; it logs at boot whether forwarded-host
  trust is on and how many secrets it accepts (so an unfinished rotation is visible), and
  logs `tenancy.edge_auth_mismatch` at `warn`, once a minute at most, when a caller
  presents a secret matching neither — the failure a rotation mismatch produces, which is
  otherwise a silent full-environment outage. This is the half that reads what TAR-64's web
  tier already sends, so tenant resolution works end to end for the first time; both
  services must hold the same `TRUSTED_PROXY_SECRET`, and `render.yaml` gains
  `TRUSTED_PROXY_SECRET_PREVIOUS` on each API service for the rotation. (TAR-148)

- **The auth pipeline is global, so a new endpoint is closed before anybody thinks about
  it** — `HostTenantGuard`, `PrincipalGuard` and `PermissionGuard` are registered as
  `APP_GUARD` by a new `RequestPipelineModule` and run on every route in the application.
  They were opt-in per controller until now, and two controllers had already shipped
  without them: `GET /api/v1/message-templates` and the three `/api/v1/media` routes stood
  on a hand-written tenant check that kept anonymous callers out and enforced no
  permission at all. Both now state their permission like every other route. Opting out
  takes one of exactly two decorators — `@Public()` (no session; the tenant is still
  resolved from the host, for login and password reset) or `@PlatformRoute()` (outside
  tenancy entirely, for health, the Meta webhook and `/api/v1/admin/*`, each authenticated
  by its own mechanism) — and `route-posture.spec.ts` fails CI for any registered route
  that declares neither a permission nor an exemption. (TAR-58)
- **A session replayed at another tenant's host is answered `tenant_mismatch` and paged**
  — the tenant-scoped session read matches zero rows under RLS, which is indistinguishable
  from an expired cookie, so `SessionReplayProbe` runs one read-only unscoped `SELECT` to
  classify the rejection (TAR-53, decision 2 — the sixth and last entry on ADR 0002's
  `SystemPrisma` call-site list). A live session elsewhere emits an
  `auth.tenant_mismatch` event carrying both tenants, the session, the user and the target
  route; anything else stays an ordinary `unauthenticated`. The response body carries none
  of it, and neither log line nor response ever contains the token. (TAR-58)

### Added

- **Console routes enforce the session, and the API is the only thing that decides who you
  are** (TAR-62) — every route below `app/(app)` is now guarded in two halves. `proxy.ts`
  (Next 16's rename of `middleware.ts`) checks only for a session **cookie**, because it runs
  on prefetches too and an API call per prefetch would be a self-inflicted load test;
  `verifySession()` asks `GET /api/v1/auth/session` and is the half that actually decides.
  Both send the caller to `?next=`-carrying sign-in, narrowed by `parseRedirectPath` so a
  crafted value cannot bounce a freshly authenticated user off-site. The check lives next to
  the data rather than in the layout — a layout does not re-render on client navigation and
  does not control whether the segments below it render — so `lib/api/authenticated.ts` is
  now the transport for every authenticated call: it verifies the session, forwards the
  caller's cookie, and turns a lost session into a sign-in. That last part closes a real gap:
  `lib/api/users.ts`, `teams.ts` and `conversations.ts` were making server-side calls with
  **no cookie at all**, so every list would have been anonymous to the API the moment the
  mock transport was switched off. 401 `unauthenticated` and 401 `tenant_mismatch` redirect;
  403 `forbidden` keeps the explanatory state, because bouncing a signed-in caller to sign
  in tells them to fix the one thing that is not wrong; a 502 is rethrown, because
  redirecting on it would sign everybody out whenever the API restarted. Nothing is cached
  across requests, so a deactivation, a reset or a sign-out lands on the next request rather
  than whenever a copy expires. Also new: a **Sign out** control in the shell —
  `signOutAction` revokes server-side first and then clears the browser's cookie, since the
  API's `Set-Cookie` comes back to the Next process rather than to the person leaving.

- **Password recovery and change screens** — `/forgot-password` requests a link and shows
  one confirmation whatever came back, so the screen cannot answer the question the
  endpoint's unconditional 204 refuses to; `/reset-password` reads the token from the URL
  **fragment**, scrubs it from the address bar, and turns a dead link into "request a new
  one" rather than an error above a form nobody can use; `/settings/security` changes a
  known password and says plainly that this device stays signed in while every other one
  does not. All three are token-driven and copy-driven, so TAR-29's white-label branding
  applies without touching a component. `app/` gains two route groups — `(app)` carries the
  console shell, `(auth)` carries the signed-out card frame — because a visitor following a
  reset link has no session to resolve; every URL is unchanged. New shared pieces:
  `AuthCard`, `AuthForm`, `AuthOutcomeCard`, `PasswordField`, `FormError` (extracted from
  `FormDialog`), `TextLink` and `RouteErrorFallback`, all of which TAR-60's login and
  invite-accept screens reuse as they stand. `/settings/security` is the first navigation
  entry with no `requiresAny`, meaning every signed-in role, because a password screen
  gated on a permission is a password some people cannot change. (TAR-61)

- **Brute-force protection an admin can see and clear** (TAR-59) — the lockout TAR-56
  writes is now readable and reversible. `UserResponse` carries a `security` object
  (`lockedUntil`, `failedLoginAttempts`) for callers holding `user:update`, and `null` for
  everyone else, so an admin or supervisor can see who is locked out while an agent — who
  also holds `user:read` — cannot watch a colleague's failures climb.
  `POST /api/v1/users/{id}/unlock` clears it, is idempotent, and audits `auth.unlock` only
  when it actually cleared something. Alongside the per-account counter, a per-address
  sliding window in Redis (`AUTH_POLICY.ipFailureThreshold` failures per
  `ipFailureWindowMs`, keyed by tenant **and** address) catches credential stuffing sprayed
  at addresses that have no account here and so trip no per-account counter; it is checked
  before the user lookup, so a blocked address never reaches an Argon2id verify. Both
  layers answer `rate_limited` with `Retry-After` and the same message as each other, so
  neither confirms an address exists. New: `LOGIN_IP_THROTTLE_ENABLED`, off by default —
  `trust proxy` is deliberately unset, so behind a load balancer `request.ip` is the proxy
  and one shared window would lock a whole tenant out. The per-account lockout does not
  depend on it.

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
- **Invitations, and the account they create** — an admin invites an address with a role
  (`POST /api/v1/users/invites`, `user:invite`), can list, resend and withdraw those
  invitations, and the invitee redeems the emailed link at `POST /api/v1/invites/accept`
  after previewing it at `POST /api/v1/invites/lookup`. Acceptance sets a password, turns
  the reserved `invited` row into an active account **inside the inviting tenant with the
  role the admin assigned**, joins the teams the invitation parked, and issues the session
  cookie. Nothing about the tenant or the role comes from the request body. Tokens are 32
  random bytes, stored only as a SHA-256 digest, valid for seven days, and single-use
  because redemption is a conditional `UPDATE … RETURNING` rather than a read-then-write —
  an expired, withdrawn or already-used link answers `token_invalid` (410) naming which.
  Re-inviting an address is an upsert on the partial unique index, so a lapsed invitation
  can never make an address un-invitable: `201` when a row was written, `200` when one was
  refreshed. `DELETE /api/v1/users/{id}` now withdraws any outstanding invitation for that
  address in the same transaction, so removing somebody who never accepted cannot be undone
  by whoever still holds their emailed link. Passwords go through the same
  `PasswordService` login uses, and acceptance issues its session through `SessionService`
  rather than a second minting path. Mail goes through a `MailerPort` with a console
  adapter outside production, because no provider has been chosen yet (ADR 0005, open
  question 2). (TAR-55)
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
  `main` and every pull request; branch protection on all four. (TAR-40, TAR-96)
- **Published architecture and API contract** — module boundaries, tenant resolution, the
  endpoint surface, webhook ingestion, and the billing and usage ports.
  (TAR-39, amended by TAR-20a)
- **Documentation** — a data model reference, a platform admin API reference, the tenant
  isolation contract, and the documentation style guide this file follows. (TAR-89)

### Changed

- **The local Postgres major matches Render's.** `docker-compose.yml` pinned
  `postgres:17-alpine` under a comment claiming it tracked the managed offering, while all
  three databases in `render.yaml` pin `postgresMajorVersion: '16'`. CI builds its database
  from the same Compose file, so a construct that only exists in 17 would have passed every
  check and failed on Render's `preDeployCommand` instead. No such construct had been
  written yet. `db:restore-drill` now defaults its client image to 16 for the same reason.
  **An existing `pgdata` volume created by the 17 image will not start under 16** — a data
  directory cannot be downgraded in place; `docker compose down -v` and rebuild, per the
  README. (TAR-147)
- **`x-request-id` is repeated only within a bound.** The caller's value is echoed into the
  response header, every log line, the error envelope and the Sentry tags for the request,
  and was previously accepted at any length and any content. It now has to be at most 128
  characters of `A-Za-z0-9._-`; anything else gets a fresh UUID rather than a truncation
  that would look like the caller's id and correlate with nothing. Nothing was injectable
  through it — pino JSON-encodes its fields and Node rejects control characters in a header
  value — but the API deliberately does not trust the proxy in front of it, and an
  unbounded id is a caller deciding how much log volume the platform pays for. (TAR-147)
- **Revoking a session marks it revoked rather than deleting the row.** A role, status or
  team change — and an admin suspending or removing an agent — now writes `revoked_at` and
  `revoked_reason` instead of `DELETE`ing, and purges the Redis principal cache on both
  sides of the commit. Access still ends at the commit: every read path filters
  `revoked_at IS NULL`, and the second purge closes the window in which an in-flight
  request could repopulate the cache from the not-yet-revoked row. What it buys is a trail
  that can say _why_ every session for one person died at 14:03, and a device list that
  stops showing a session that is gone. Revoked and expired rows are not yet swept — see
  the follow-up note in TAR-53's failure-modes table. (TAR-56)
- **An invitation's teams wait on the invitation.** `POST /api/v1/users/invites` moved from
  `PeopleModule` to `IdentityModule` and now writes the requested teams to `invite_teams`
  instead of joining them immediately; acceptance is what turns them into `team_members`.
  Somebody who never accepts therefore never widens a team's membership — and so never
  widens what its members can see. The address is still reserved as an `invited` account, so
  the people list and seat accounting are unchanged. `InviteResponse` gains `teamIds` and
  `revokedAt`, and `invitedByUserId` becomes nullable to match the column. (TAR-55)
- **The `Database` job gates the merge.** It is now one of `main`'s required status checks
  alongside `Lint`, `Type-check` and `Test`. It ran on every pull request before, but a red
  result did not block anything — and it is the only check that proves tenant isolation, so
  a broken policy, a missing grant or a `BYPASSRLS` role could go red and merge anyway.
  (TAR-96)
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

- **The browser's own API calls name their tenant too, and the naming is now provable**
  (TAR-64) — the `/api/*` rewrite is where the browser path loses the tenant: Next's proxy
  replaces `Host` with the API origin, and `rewrites()` cannot add a request header. So
  `proxy.ts` now matches `/api/` — skipping the sign-in redirect for it, since answering an
  XHR with an HTML page turns a clean 401 into a parse failure — and attaches the same pair
  the server-side transport sends. Both headers are deleted and then `set`, never appended,
  so a caller that names its own tenant is overwritten rather than spliced, and a pair that
  arrived from the browser never travels on even when this tier has nothing to replace it
  with. `x-edge-host` carries the tenant; `x-edge-auth` carries `TRUSTED_PROXY_SECRET`,
  which is what makes the first believable — a forwarded host on its own is a tenant the
  caller chose. **Both are private names, not `x-forwarded-*`** (TAR-148): the web tier
  reaches the API over the public internet, through TLS-terminating proxies that populate
  the standard forwarding headers as a matter of course and are entitled to rewrite them,
  and an edge that did would leave every tenant route answering a uniform
  `tenant_not_found` while both services still reported the feature enabled. The two names
  live in `@whatsappcrm/contracts` beside the session cookie's, so the console and
  `HostTenantGuard` read one definition and a rename cannot reach one side only; a contract
  test pins both spellings, because changing them changes a deployed wire format. The
  secret is server-only (never `NEXT_PUBLIC_`, which would hand it to every visitor) and
  read at runtime rather than baked into the build, so rotating it is a restart. Verified
  against the installed Next 16.3 on both paths, including that a forged pair from the
  client is replaced and that the value appears in no browser asset — and `proxy.int-test.ts`
  now keeps it verified: it runs a real `next build` and `next start`, points the `/api/*`
  rewrite at a probe standing in for the API and asserts what the probe actually received,
  since whether Next applies middleware-injected headers to a request it proxies to an
  **external** origin is undocumented and has changed between versions. It is a separate
  script (`pnpm --filter @whatsappcrm/web test:int`) rather than part of `pnpm test`,
  because it overwrites `.next`, and it runs in CI alongside it.
- **Server-side API calls now name the tenant they are for** (TAR-64) — every call made by
  the Next process went out with no indication of the host it came in on, so
  `HostTenantGuard` would resolve no tenant and answer `tenant_not_found` the moment the
  mock transport is switched off: not one screen, but every server-rendered route in the
  console, in every environment. `lib/api/tenant-host.ts` forwards the incoming host as
  `x-forwarded-host`, and it is applied in `apiRequest` rather than per resource module, so
  a new call site cannot forget it — including the unauthenticated ones, since sign-in and
  password reset are tenant-scoped too. The pair is merged **after** the caller's own
  headers rather than before, so a call site cannot replace it: every other header there is
  a default worth overriding, and this one decides which tenant's data comes back. A
  request that arrives with no host now fails loudly there instead of as an unrecognisable
  404 three layers down, and one with no secret configured sends neither header rather than
  a host with nothing to vouch for it. A forwarded host rather than `Host` because `Host`
  cannot be set on either path, both verified against the versions in this repository:
  Next's rewrite proxy hardcodes `changeOrigin: true` and replaces `Host` with the API
  origin, and `fetch` derives `Host` from the URL and silently drops a caller-supplied one. **The API side is still to come**: `HostTenantGuard`
  reads `Host` only, so both paths stay broken until it reads the forwarded host under the
  secret gate. ADR 0005's sequence diagram, which assumed `Host` was preserved, carries the
  correction and the trust decision.
- **`API_BASE_URL` is declared for the web service in every environment** (TAR-64) — it was
  missing from all three, and `next.config.mjs` reads it at _build_ time and freezes the
  `/api/*` rewrite destination into `.next/routes-manifest.json`. Every deployed build
  therefore proxied the browser to `http://localhost:3001/api`, and server-side calls went
  to the same place, so the console could not reach the API at all regardless of tenancy.
- **`SENTRY_DSN` can be set from the repository `.env`.** `instrument.ts` runs before
  `AppModule` exists — that is the point, the SDK has to instrument modules before they are
  imported — so it read `process.env` before `ConfigModule` had loaded the root `.env`, and
  a DSN put there was silently ignored. It now loads that file itself, the same way
  `prisma.config.mjs` does, so pointing local development at a tracker works. Deployed
  environments were never affected: there the DSN is a real environment variable, and
  neither loader overwrites one that is already set. (TAR-147)
- **README's model counts match the schema.** It claimed 37 models and 34 tenant-scoped
  while `docs/reference/data-model.md` claimed 40 and 37; `schema.prisma` has 41 models, 38
  of them tenant-scoped with a `tenant_isolation` policy each. Both documents, and
  `docs/reference/tenancy.md`, now say the same thing. (TAR-147)
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

- **A password reset or change now ends the sessions it revokes immediately, not up to a
  minute later.** Both flows revoked the session rows correctly but skipped the
  after-commit `purgeCacheFor` that `SessionRevocationService` documents as mandatory, so
  a request in flight during the transaction could repopulate the Redis principal cache
  from the not-yet-revoked row — leaving a revoked session answering for the remainder of
  its 60-second TTL. That window is the whole point of both flows: the person resetting is
  often not the person holding the other devices. Every other revocation path (role,
  status, teams, removal, logout) already made the call. (TAR-55, TAR-57)
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
