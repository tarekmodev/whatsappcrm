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

- **Two agents can no longer both reply into the same unclaimed conversation** (TAR-186) —
  TAR-68 made an unclaimed thread visible to every agent on the tenant, which is what a
  shared inbox is for, and left it writable by every one of them too. Two agents looking at
  the same arriving conversation both replied, and the customer got two answers;
  `Idempotency-Key` cannot catch that, because each agent sends a distinct request with a
  distinct key. The rule is now **readable by everyone, writable by nobody**: the send, the
  internal note and the status change refuse a conversation with no assignee and no team
  with `conflict`, uniformly across roles — a supervisor replying into the pool produces the
  same two answers, and a role branch inside a write path is what ADR 0004 exists to forbid.
  The list, the detail read, the message history and the read receipt are untouched.
  Taking work out of the pool is the new `POST /conversations/{id}/claim` on a
  `conversation:claim` **every role holds** — ADR 0004 open item 2, resolved. It takes no
  body, so the assignee is always the session's own principal, and it is a compare-and-set
  (`WHERE assigned_user_id IS NULL`), so of two agents claiming at the same moment PostgreSQL
  picks the winner and the other is refused rather than silently overwriting them — with
  `conflict` if they could still see the thread, `not_found` if the winner's claim had
  already taken it out of their view.
  The holder re-claiming their own thread gets it back with a 200, so a double-click is not
  a lie. A conversation routed to a team may be claimed by one of its members and stays that
  team's; a thread somebody is already on can never be taken through this route, whatever it
  is called with — that is still `conversation:assign`, still supervisor and above, and still
  deliberately a blind write, because an assignment that refused an already-held thread could
  not do the job it exists for. The console follows: the Claim button now appears for agents,
  and the composer and the note box are shut on an unclaimed thread with the reason on screen
  rather than letting somebody type a reply that can only end in a 409. Recorded as ADR 0002
  amendment 6 and ADR 0004 invariants 6–8. ⚠️ Still open, and stated rather than left to be
  discovered: two members of the _same team_ can both reply to a thread routed to that team.
- **The audit trail names which operator acted, on both WhatsApp connection paths**
  (TAR-166) — `audit_logs` had one actor column, `actor_user_id`, and a null in it said two
  different things: the platform acted, or nothing recorded who. Connecting a WABA hands the
  platform a credential that can message a business's customers in its name, and the row
  recording it was indistinguishable from a row nobody attributed at all. Three changes
  close that. `audit_logs` gains `actor_label` and an `actor_type` of `user`,
  `platform_operator`, `system` or `unattributed`, indexed on
  `(tenant_id, actor_type, created_at DESC)`
  because "everything this operator did" is the query an auditor runs, and constrained by
  `audit_logs_actor_attribution` so a label cannot land on a row attributed to a tenant user.
  Existing rows are backfilled to `user` where they name one and `unattributed` where they do
  not — history is read, never guessed at, and no new row can claim `unattributed`.
  `PLATFORM_ADMIN_TOKEN` becomes a set of `label:secret` entries; `PlatformAdminGuard`
  compares the presented value against **every** entry with no early exit, so an entry's
  position in the set is not timing-observable, and publishes the matching label on the
  request scope where `AuditService` writes it. And the WABA connection's audit write moves
  out of `business-account-connection.service.ts` into `AuditService`, at the same action
  string, so the actor comes from the request scope rather than from an argument — which is
  what lets the tenant-facing route (TAR-168) record the tenant admin who connected it
  without that service knowing either path exists. ⚠️ **Deploy step**: an unlabelled
  `PLATFORM_ADMIN_TOKEN` is refused at boot, with no transitional dual-accept, so every
  environment holding it must be updated to the labelled form in the same release.
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

- **A supervisor can now build trigger → condition → action automations, and they run without
  anybody watching** (TAR-27, TAR-395) — a workflow is one rule: one trigger, one condition
  set, one ordered action list, and the tenant's workflows _are_ the rule list the console
  renders. `POST /api/v1/workflows` and its five siblings, plus
  `GET /api/v1/workflow-catalog` for the vocabulary a builder renders from — one endpoint
  rather than three listings, because a form needs all of it before it can draw anything and
  three endpoints can disagree across a deploy. The launch actions are `add_ticket_tag`,
  `reassign`, `notify` and `set_status`/`set_priority`; the five triggers are ticket created,
  status changed, assigned, SLA breached, and unresolved for N minutes.

  **Exactly-once is one unique index, and everything else is an optimisation.** The row that
  records what a workflow did is the same row that reserves the right to do it:
  `INSERT INTO workflow_runs … ON CONFLICT (tenant_id, workflow_id, dedupe_key) DO NOTHING
RETURNING id`. A ticket that stays open for six hours escalates **once**, not once per
  sweep tick, and it does so whether or not the sweep is correct — which is the failure a
  supervisor would otherwise experience as a pager. Nothing reads, decides in TypeScript and
  then writes, because the window between such a read and its write is exactly the window two
  sweep ticks race in. These jobs carry **no custom BullMQ id**, on the incident
  `@whatsappcrm/contracts/sla` documents: a ticket-keyed id collapses every occurrence after
  the first into the completed — or failed — key of the one before it.

  **A rename needs nothing and a delete is refused, both by the shape rather than by a code
  path.** A definition stores taxonomy ids and only ids, so renaming a tag a workflow uses
  requires no migration, no backfill and no cache bust; the name reaching the console is
  joined at read time, and a reference whose row is gone comes back `exists: false` so the
  rule renders as visibly broken instead of quietly healthy. `workflow_references` carries
  real composite foreign keys, so PostgreSQL — not a cross-module call the layering rule
  forbids — is what refuses to delete a tag or team a workflow names. Removing a _user_ still
  always succeeds, because that is a security action, and leaves the workflow deactivated
  with `brokenReason: 'reference_removed'`.

  Three bounds contain the loop a workflow's own writes create: the dedupe key (a workflow
  cannot fire twice for one occurrence, so it cannot trigger itself), `maxChainDepth`, and a
  per-ticket hourly run budget that records a `failed` run rather than dropping silently —
  the tenant's rule is what is wrong, and a supervisor needs to find it in the run list
  rather than in our logs. `POST /workflows/{id}/test` is a dry run that **writes nothing**;
  `GET /workflows/{id}/runs` is what to read first when a rule looks wrong, before the
  definition.

- **An agent can now hand on the ticket they are working, with a reason, and raise a
  supervisor without losing it** (TAR-32, TAR-468, TAR-469, TAR-470, TAR-473) — TAR-32 asked
  for two things a ticket could not do. Neither needed much new machinery, and
  [ADR 0011](docs/architecture/0011-ticket-reassignment-and-escalation.md) is mostly a set of
  rulings on what to reuse.
  **The first was a genuine conflict with a shipped decision.** TAR-32 opens "as an agent",
  and ADR 0004 grants `ticket:assign` to supervisor and above — so an agent could not move a
  ticket at all. Widening `ticket:assign` was rejected: it would hand every agent the right to
  take a ticket _off_ a colleague, which is exactly what ADR 0004 split `conversation:claim`
  out of `conversation:assign` to prevent. Instead `POST /tickets/{id}/assign` now declares a
  new **`ticket:handoff`, held by every role**, and the service applies the bound that
  `ticket:assign` skips: you hold the ticket, the target is a teammate, and somebody still
  holds it afterwards. Releasing a ticket to nobody is abandonment rather than a handoff and
  stays supervisor-and-above. The cost is a route whose declared permission is weaker than one
  of its behaviours — which is where authorization bugs live — so each of the three refusals is
  asserted against a real database in `ticket-handoff.int-spec.ts` rather than assumed from a
  comment.
  **`reason` is now required, but only when the ticket already has a holder.** That asymmetry
  is the design, not an oversight: a reassignment takes work away from somebody, and that is
  the case where a ticket has a holder to take it from; a supervisor emptying the flagged queue
  is placing work nobody held. Always requiring it would put a mandatory free-text field in
  front of a bulk triage action and break a console already calling the route without one. The
  rule is published as `ticketAssignRequiresReason` so the form and the API cannot drift, and
  `reason` gained a trim and a three-character floor, because the empty string satisfied
  "present" and logged nothing.
  **Escalation is a signal, not a reassignment upward.** `POST /tickets/{id}/escalate` writes
  an `escalated` event and notifies; the ticket does not change hands. An escalation that
  un-assigned the agent would leave the customer with nobody at 02:14 while the supervisor
  slept, and would make "escalate" the one button that loses your work. Recipients come from
  `resolveAlertRecipients`, imported unchanged from the SLA module — a breach and an escalation
  ask the same question, and two answers that drifted would reach different people.
  **Nobody to notify is a success, not an error**: the event is written, `notifiedUserIds` comes
  back empty, an operator warning names the ticket, and the console says "recorded, but nobody
  was notified" rather than showing a green tick that would be a lie or an error the agent
  cannot fix. Re-escalation is deliberately allowed — a second ask after silence is legitimate,
  and suppression is magic — so the route takes an **optional `Idempotency-Key`**, the first
  non-billing route in this API to do so.
  `GET /tickets/{id}/events` ships alongside them, reserved since TAR-25 and the only reason
  any of this is visible; it inherits the ticket's visibility rule exactly, so a ticket the
  caller may not open is `not_found` there too rather than a side channel onto it. The
  supervisor's `/escalation-alerts` list and acknowledge are narrowed to the calling principal
  on top of row-level security, and another principal's alert answers `not_found` rather than
  `forbidden`, because a 403 confirms the id names a real alert somebody else was sent.
  **What it cost.** ADR 0011 decision 5 specified a parallel `escalation_alerts` table and named
  the _third_ notification type as the trigger to generalise. TAR-394 reached that point first,
  at the second type, so TAR-468 shipped escalation as `notifications.type = 'escalation'` and
  the decision carries an amendment saying so. Nothing downstream noticed — the published
  contract is ADR 0011's Interfaces section verbatim — but the ADR and the schema now disagree
  unless you read the amendment, which is a tax on the next reader.
  ⚠️ **`GET /escalation-alerts` has no console surface.** There is no escalation list, no bell
  entry and no acknowledge control, and the console maps the `ticket.escalated` socket event to
  `ignore`. A supervisor is notified in the durable sense the API guarantees — the row exists
  and the list read returns it — but today they reach it through the API or by opening the
  ticket's history. Its own story.
  A worry TAR-470 raised — that a rule-routed ticket carries `assignedTeamId` and would drag
  the supervisor's flagged-queue placement into needing a reason — turned out to rest on a false
  premise, and TAR-537 settled it: a matched rule assigns and stops, so every `deferred` row has
  both assignment columns null and the exemption in decision 1 reaches the flagged queue exactly
  as intended.
  ⚠️ **No de-escalation and no "is escalated" state on a ticket.** `acknowledgedAt` on the alert
  is the supervisor's half; nothing lists open escalations per ticket, and one raised in error
  stays in the history. Escalations are not rate-limited, and alert retention is still unset —
  to be settled with `sla_alerts` rather than given a second policy here.
  Documented in [the tickets API reference](docs/reference/tickets-api.md) and, for agents, in
  [Hand a ticket on, or ask a supervisor](docs/guides/hand-over-or-escalate-a-ticket.md).
  [Clear tickets nobody could take](docs/guides/clear-flagged-tickets.md) gains the optional
  reason field the flagged-queue dialog now offers.

- **Canned responses are documented, for both readers** (TAR-489) — TAR-31 shipped a
  tenant-shared quick-reply library across five merged pull requests: the database bounds,
  the CRUD surface, the realtime relay, the composer's shortcut picker and the console's
  refresh on an edit. None of it had documentation, and the two facts a reader most needs
  were the two least visible in the source.
  [The canned responses API reference](docs/reference/canned-responses-api.md) is the
  engineer's: the five routes with parameters, examples and every error, the four limits
  `CANNED_RESPONSE_LIMITS` publishes, the shortcut grammar and why it is enforced twice, the
  audit actions, the two server events and the room they are addressed to, and the isolation
  properties. It records the things a reader would otherwise derive from source — that the
  list is unpaginated **on purpose**, because the console resolves a typed shortcut against
  its own copy of the whole set rather than putting a request on the keystroke path, and
  that `perTenant` enforced on create is what makes that bounded response a promise the
  server can keep; that a `PATCH` moving no column writes nothing, audits nothing and
  announces nothing, so a caller cannot tell a no-op from a write; that `DELETE` is
  idempotent and clears nothing, because a body is copied into the draft at insertion time;
  and that another tenant's id is `not_found` rather than `403` because row-level security
  means the server genuinely cannot tell it from an id that never existed. `is_shared` is
  documented as a deliberate absence from the DTO rather than left as a column a reader
  finds in `schema.prisma` and wonders about.
  [Answer common questions with saved replies](docs/guides/use-saved-replies.md) is the
  agent's, and refuses all of that vocabulary — including the term _canned response_, which
  no screen in the console uses. It says where a code is recognised and why (start of the
  message or after a space, so a web address ending in `/hours` does not open a menu
  mid-link), what the list matches and in what order, what each key does, and — first,
  because it is the thing an agent most needs to trust — that **inserting a reply never
  sends it**.
  `canned_responses` in [the data model reference](docs/reference/data-model.md) is brought
  up to what TAR-475 actually shipped: `citext`, the four CHECK constraints Prisma cannot
  express, and why the by-creator index stays although no application query reads it.
  ⚠️ Three gaps are marked rather than left to be discovered. **There is no console screen
  for writing** — `POST`, `PATCH` and `DELETE` have no settings surface and the web client
  exposes only the list, so a supervisor manages the library through the API, which is what
  the guide's last section has to tell a non-technical reader. **The design document the
  code cites throughout — `docs/architecture/0011-canned-responses-contract.md` — is not in
  the repository**, so every "0011, decision N" in the reference is transcribed from source
  comments rather than read from the contract; its number is also already taken by
  `0011-ticket-reassignment-and-escalation.md`. And **nothing records which responses are
  used**, so a library nobody prunes cannot be pruned on evidence. Each carries a
  `TODO(author)` naming the question and who should answer it.

- **The reporting dashboard and its export are documented, for both readers** (TAR-434) —
  TAR-30 shipped a performance dashboard, a CSV export and the guarantee that the two agree,
  across six stories and four merged pull requests. None of it had documentation, and the
  parity guarantee in particular is the kind of property that is invisible until somebody
  reimplements around it. Two pages, split by reader rather than averaged into one.
  [The reporting dashboard and export reference](docs/reference/reporting-api.md) is the
  engineer's: both endpoints with every parameter, the CSV byte format, the error table, and
  — at length, because it is the design and not a detail — **why the file and the screen
  cannot disagree**. `ReportingQueryService.dashboard()` is the only method that aggregates
  ticket metrics, both routes call it, and there is no SQL on the export path, so parity is
  structural rather than maintained by attention. It also documents what a reader would
  otherwise have to derive from source: that each metric is anchored on the event that makes
  it true rather than on `created_at`, which is what makes a range reproducible; that
  durations are null exactly when the sample is empty, because a week nobody answered and a
  week answered instantly are different facts; and the asymmetry between visibility and
  attribution — visibility reads _current_ assignment, attribution reads _recorded_ history,
  so an agent's own response on a ticket since reassigned away leaves their scoped report
  while staying on their row in a supervisor's.
  [Read the performance dashboard](docs/guides/read-the-performance-dashboard.md) is the
  supervisor's, and refuses all of that vocabulary: what each figure counts, why opened and
  resolved are not meant to reconcile, why medians must not be averaged down the column, and
  why the export always matches the screen. Both pages say plainly that **durations are
  wall-clock** — a ticket arriving at 17:30 carries the whole night in its first response
  time, and a client-facing report inherits it.
  Everything on the reference page was executed against a local stack rather than read off
  the source: parity was compared field by field between the CSV `total` row and the JSON
  summary, the byte-order mark was checked byte by byte, an agent renamed `=cmd|' /c calc'!A1`
  was confirmed exported inert, and the range cap was probed at 366 and 367 days. The
  reporting suite passed at 87 tests. ⚠️ Three things are marked as unresolved rather than
  written up as settled, because they are product calls nobody has made: whether an agent
  should see a per-agent breakdown of their team (ADR 0010 open question 1), whether p50/p90
  are the intended definition (risk 7), and the wall-clock question, which ADR 0006 raised
  first for SLA windows and which should be answered once for both. A fourth is a defect
  found while verifying and reported rather than fixed: `validation_failed` on these routes
  says "The request body failed validation." on two routes that read only the query string.

- **A tenant can put its own name, logo and colours on the product, and serve it from its own
  web address** (TAR-29) — the white-label surface. `tenant_branding` and `tenant_domains`
  now exist and are written; `PATCH /api/v1/tenant`, `PUT`/`DELETE /tenant/branding/{kind}`
  and the five routes under `/tenant/domains` are the tenant-facing half, and
  `GET /tenant/public` plus `GET /tenant/branding/{kind}` are the unauthenticated pair that
  makes the **sign-in screen themeable before anybody has a session** — TAR-35's requirement,
  and the reason a tenant identifier appears nowhere in any of these contracts. The console
  gets two settings screens behind two permissions: `branding:write` for the editor, and a
  separate `domain:write` for hostnames, because DNS control decides where every invitation
  and password-reset link in the tenant is addressed and choosing a colour does not. Both are
  admin-only today. ⚠️ `settings/workspace` still carries its pre-TAR-418 notice — "The
  branding editor … arrives with the white-labelling work" (`BrandingSummary.tsx`,
  `workspace.brandingPendingNotice`) — and so does the onboarding checklist's
  `unavailableNotice`. The editor exists now, on its own **Branding** screen; both notices
  describe a gap that has closed and are copy left for a follow-up.
  Four decisions are worth reading before building on this. **The tenant is the host and is
  never in the request** — every route above is the same URL for every tenant, so the two
  public ones send `Vary: x-edge-host` and any cache in front of them that keys on the URL
  alone is a direct cross-tenant leak, which is the highest-severity mistake this feature
  makes available. **Branding defaults live in `@whatsappcrm/contracts`, not as column
  defaults**, so the response is always fully populated and "has this tenant customised
  anything" stays answerable. **Uploads are sniffed, never trusted**: the declared
  `Content-Type` is not consulted, the sniffed value is what the serve route later sets, and
  `image/svg+xml` is refused outright rather than sanitised — an SVG served same-origin
  executes script, and a sanitiser is a security dependency to own forever. And **a domain's
  status is derived from its timestamps rather than stored**, because a stored status
  disagrees with its own columns after one failed write.
  Isolation rests on two things the integration suite asserts against a real database rather
  than on either alone: `hostname citext UNIQUE` is global and enforced **below** row-level
  security, so the loser of a race for one hostname gets `conflict` and cannot read, or learn
  anything about, the holder; and a verified-but-unattached domain receives no traffic while
  an attached-but-unverified one answers `tenant_not_found` on every route — two halves held
  by different parties, neither able to forge the other.
  The cost is a wait, and it is the honest headline. **`verified` and `live` are separate
  states because attaching a hostname at the edge is a manual operator step**: the platform
  proves ownership automatically, then the domain sits on `GET /api/v1/admin/domains` until
  somebody attaches it and posts the activate route. Promoting a verified-but-unattached
  domain to primary is refused for that reason — the mail would send and nobody could accept
  an invitation. There is also a hosting cost: **Render bills the platform per custom domain**
  beyond the web service's own allowance, which grows linearly with exactly the customers this
  is sold to. Nothing meters it per tenant — `custom_domain` is a boolean plan feature and the
  only ceiling is the flat `MAX_CUSTOM_DOMAINS_PER_TENANT`. Documented in
  [the custom domains runbook](docs/runbooks/custom-domains.md),
  [the API reference](docs/reference/branding-domains-api.md) and the two admin guides
  ([branding](docs/guides/brand-your-workspace.md),
  [custom domains](docs/guides/set-up-a-custom-domain.md)).
  ⚠️ Four things shipped knowingly incomplete, each named rather than left to be discovered.
  **Apex domains are refused** — a root domain cannot take the `CNAME` the routing record
  hands back — and the check counts labels rather than consulting a Public Suffix List, so
  `acme.co.uk` is accepted and will never route; raised against TAR-416. **TAR-416's second
  verification throttle, 20 checks per hour per tenant, is not built**: it needs a shared
  sliding-window counter, and the durable 10-second per-domain floor is the only control
  today. **Periodic re-verification is deliberately absent** — a tenant that repoints DNS
  after verification leaves a stale verified row, which is better than letting one DNS blip
  un-verify a live domain. And **the activation queue has no alerting**: "verified more than
  24 hours ago with no activation" is the failure mode this feature actually has, and it is a
  daily digest somebody has to build.

- **An admin can now define the tenant's custom contact fields, and the contract says what a
  value means** (TAR-33, TAR-476) — `custom_field_defs` has existed since the initial
  migration and `CustomFieldDefinitionSchema` has been published since TAR-39, but nothing
  wrote either, so TAR-33's first acceptance criterion had no route. The console was already
  living in the gap: `contact-schema.ts` read `/v1/custom-fields` for the routing-rule
  condition builder and treated `not_found` as "this tenant has no vocabulary yet".
  [0002 amendment 10](docs/architecture/0002-architecture-and-api-contract.md) rules the five
  endpoints and, more importantly, the four things a client would otherwise discover by
  trying. **`key` and `type` are immutable**: `key` is the JSONB key inside
  `contacts.custom_fields` and the key a `contact_attribute` routing condition names, so
  renaming it orphans every value and silently stops every rule naming it from ever matching;
  `type` is what every stored value was validated against, and changing it leaves an agent
  holding a profile the API refuses to save back. `label` and a `select`'s `options` are the
  renameable half, and removing an option rewrites no contact — a stale value survives
  untouched until that field is next written. **Delete strips the values in the same
  transaction**, because keys are unique per tenant and leaving them orphaned means an admin
  who deletes a field and later re-creates the same key gets every old value back on a screen
  that gives no hint they were ever there. **`ContactResponse.customFields` is keyed by `key`,
  and a write is a merge** — keys present are set, `null` clears one, absent keys are left
  alone — because replacement makes an agent editing a phone number silently erase every
  custom value their form did not load. Ordering is `position`, set only by
  `POST /custom-fields/reorder` on amendment 7's shape, so "move this field up" is atomic
  rather than a client-computed renumbering raced by the next admin.
  Mutation is gated on `tenant:settings`, which is admin-only today and grows `rbac.ts` by
  nothing; the list is `contact:read`, because every agent has to render the fields to fill
  them in. No migration and no new error code. `customFieldValueIssue` in
  `packages/contracts/src/contacts.ts` is the single copy of per-type validation, so the
  console disables a save the API would refuse. `multi_select` stays in the Postgres enum and
  out of `CUSTOM_FIELD_TYPES`: a value is a single string, and TAR-33's own assumption is
  "simple key-value, not relational".

- **The two JSONB columns the custom-field surface is built on are now shape-checked in the
  database** (TAR-33, TAR-478) — TAR-478 checked `contacts`, `tags`, `contact_tags` and
  `custom_field_defs` against [0002 amendment
  10](docs/architecture/0002-architecture-and-api-contract.md) and found the schema already
  carries every column, type, key and index that contract needs, with tenant isolation
  enforced at the data layer on all four. It found one thing that was assumed and not
  enforced. `contacts.custom_fields` took any JSONB, and amendment 10's delete path is
  `custom_fields - $key`, which is defined only for objects: against an array it silently
  removes an _element_, and against a scalar it raises `cannot delete from scalar` — so one
  unrelated row written by an import or a backfill would take down the transaction that
  deletes a custom field. `contacts_custom_fields_is_object` closes it, and
  `custom_field_defs_options_is_array` and `custom_field_defs_position_non_negative` do the
  same for the two columns amendment 10 gives a writer. All three are additive CHECK
  constraints — no column, no index, no data, and nothing in the API changes.
  Two indexes were **declined on measurement** rather than skipped: amendment 10's optional
  `custom_field_defs (tenant_id, position, id)` changes no plan at the contract's own ceiling
  of 50 definitions per tenant (the bitmap scan discards index order, so the 50-row sort
  survives either way), and a GIN index on `contacts.custom_fields` is never chosen by the
  planner for the delete-strip's `?` predicate at the selectivity that matters. The indexes
  behind "filter the contact list by tag" are already sufficient: both plan shapes exist
  today and the planner picks between them by tag selectivity. Reasoning and numbers are in
  the migration.

- **Contacts have a directory, a profile whose custom fields agents fill in, and a tag filter
  that answers "who are all our VIP customers"** (TAR-33, TAR-479, TAR-480) — the contract
  half of this story shipped as amendment 10 above; this is the surface behind it. There was
  no `ContactsModule` and no `TagsModule` in `apps/api`, and contacts were readable only
  through the inbox's `ConversationResponse`. Eleven routes now exist:
  `GET/POST /api/v1/contacts` and `GET/PATCH /api/v1/contacts/{id}` on `contact:read` /
  `contact:write`, `GET/POST /api/v1/tags` on the same pair, and the five
  `/api/v1/custom-fields` routes with **`tenant:settings` to mutate and `contact:read` to
  list** — the split that is this story's first acceptance criterion, since every agent holds
  `contact:write` and carrying definition writes on it would let any of them redefine the
  tenant's contact record. `rbac.ts` is unchanged and there is no migration. The console gains
  `/contacts` (search by name, phone or email, filter by one tag, both in the URL so a
  filtered view is a link), a profile whose **Custom fields** card is rendered from the
  definition list in `position` order and sends only the keys the agent actually changed, and
  `/settings/custom-fields` where an admin defines, renames and deletes a field.
  **Tenant isolation is asserted rather than assumed**: `contacts-tenant-isolation.int-spec.ts`
  runs two tenants whose fixtures are identical in shape — same tag name `VIP`, same field key
  `tier`, same stored value `gold` — so a leak is visible rather than plausible, and cross-tenant
  reads and writes are refused on all three resources under all three roles including admin.
  Two things the integration run corrected, both now documented rather than assumed:
  **`tags.name` is plain `text`, not `citext`** unlike `teams.name` and `assignment_rules.name`,
  so `VIP` and `vip` are two tags a tenant can genuinely hold and the list filter supplies the
  case-insensitivity the column does not; and amendment 10's delete-strip SQL gained
  `jsonb_exists` and a `jsonb_typeof(...) = 'object'` guard, because `custom_fields - 'key'`
  removes an _element_ from an array and _raises_ on a scalar — one contact row from an old
  import would otherwise turn an admin's settings action into a 500 that aborts the whole
  delete. Contract changes are additive: `TagCreateInputSchema` and `TagListQuerySchema`, which
  0002 never published because nothing implemented `POST /tags`.
  `contact.mapper.ts` moved from `conversations/` to `contacts/` and the inbox imports it, so
  the inbox and the profile cannot show different tags for the same person.
  Deliberately out of scope, each for a reason rather than for time: `DELETE /contacts`
  (erasing a customer touches conversations, tickets and retention), `PATCH`/`DELETE` on tags
  (deleting one has to reckon with `workflow_references` refusing it), and contact creation in
  the console (a contact is created by the ingest pipeline the first time somebody messages the
  tenant, and a screen that invents one is a route into the product nobody designed).
  One thing this shipped wrong and TAR-530 has since fixed, recorded because the reasoning is
  worth keeping: the merge was credited with making two agents editing different fields on one
  contact safe. It is not — it is a pure function over a map its caller already read, so both
  callers merged into the same stored map and the second write replaced the first whole, with
  both answering `200`. `PATCH` now takes `SELECT … FOR NO KEY UPDATE` on the contact row
  before that read. The merge stops an _unloaded_ key being erased; the lock stops a
  _concurrently written_ one being erased, and conflating the two is how the concurrent case
  went unnoticed through implementation, review and a first pass of these docs.
  ⚠️ **The console cannot reorder definitions.** `POST /custom-fields/reorder` is implemented
  and tested; the admin table renders in `position` order with no drag handle, deliberately,
  rather than shipping a control that could not call the endpoint. Console admins get creation
  order until a screen exists.
  ⚠️ **Tags have no server-side cap** while definitions are capped at 50, so a tenant past 100
  tags gets a partial vocabulary in the console. The console says so on screen rather than
  mislabelling a tag as deleted, but the asymmetry is unresolved.

- **A new tenant admin now lands in a guided setup checklist they can skip and come back to**
  (TAR-36, TAR-407) — `/onboarding` walks an admin through connecting a WhatsApp number,
  inviting agents and setting branding, gated on `tenant:settings`. The rule that shapes the
  whole surface is that **completion is server-derived**: a step is done because the tenant
  actually connected a number or sent an invitation, so the write endpoint takes an intent
  (`skip` / `reopen`) and not a status. A client that could assert `completed` would let an
  admin mark a workspace set up that has no number attached to it, and the list would stop
  describing the workspace. `skipped` is its own state rather than the absence of `completed`,
  which is what makes a step returnable — the completion notice renders above the list, never
  instead of it. Which step is open lives in `?step=`, so the walkthrough is a link somebody
  can share and the back button can undo, and the only client island on the page is the skip
  button.
  `packages/contracts/src/onboarding.ts` is the checklist's contract and nothing more, which is
  the split [ADR 0009](docs/architecture/0009-tenant-lifecycle-and-self-signup.md) asks for: it
  owns the lifecycle, signup, provisioning, retention and notifications, and lists the
  checklist's own state among its non-goals. The two routes sit alongside 0009's tenant surface
  and share its `tenant:settings` gate. `set_branding` links nowhere until TAR-29 builds the
  editor — the step says so and offers the skip rather than pointing at a route that would 404.

- **A visitor can now sign themselves up and reach a working workspace, with no operator in the
  loop** (TAR-36, TAR-405, TAR-440) — TAR-19 provisioned tenants admin-only, which for a
  resellable SaaS meant a human on our side for every customer who arrived. Four public routes
  close that: `POST /api/v1/signup`, `POST /api/v1/signup/verify`, `POST /api/v1/signup/resend`
  and `GET /api/v1/signup/slug-available`, the only routes in the product that are both outside
  tenancy and unauthenticated (`@PublicPlatformRoute()`, a third posture rather than composing
  `@Public()` and `@PlatformRoute()`, so `route-posture.spec.ts` keeps its one-posture-per-route
  invariant). Verification comes **before** provisioning, and that ordering is the whole design:
  provisioning on the form POST would let anything that can send one burn platform subdomains —
  `tenant_domains.hostname` is globally unique, so a squatted slug is permanently unavailable to
  the customer who wanted it — and fill `tenants` with a row per bot. The cost is that the slug
  has to be held between the two calls, which `tenant_signups` does through a partial unique
  index on `(desired_slug) WHERE consumed_at IS NULL`; that predicate cannot also carry
  `AND expires_at > now()` because an index predicate must be `IMMUTABLE`, so the insert path
  deletes expired unconsumed rows for the slug in its own transaction first.
  `POST /signup/verify` consumes the row with a conditional
  `UPDATE … WHERE consumed_at IS NULL … RETURNING`, so the statement itself is the concurrency
  control and two clicks on one link provision one tenant. It then provisions, creates the first
  admin and issues a session in that same transaction. The password is taken at the **form**, not on the verify page: a verify page that
  asks for a password is one an attacker who intercepted the link can complete, where one that
  only confirms is not. `SIGNUP_ENABLED=false` answers `404` on all four rather than `403`,
  because a disabled feature that advertises itself is one somebody probes.
  What signup will and will not confirm is decided once. The **slug** is answered — a platform
  subdomain is public DNS, so the same answer is already available to anyone who looks — and the
  **address** never is: request and resend both answer `202` whether the address is new, has a
  signup in flight, or already runs a tenant. Rate limits are `SIGNUP_POLICY`, and each of the two
  signup-creating ones is enforced **twice**, in Redis and against `tenant_signups` itself, so a
  cache outage loosens them rather than removing them; `resend` creates no row for those counts to
  see, so its **durable** ceiling is `tenant_signups.resend_count` carried in the `UPDATE`'s own
  predicate, behind a Redis per-address window of its own.
  A resend rotates the token and deliberately does **not** move `expires_at` — the deadline
  belongs to the signup, and a renewable one would let an address hold a slug indefinitely.
  ⚠️ There is no `/signup` and no `/verify` screen in the console. The API is complete and
  nothing a customer can use reaches it yet.

- **A workspace's plan caps are enforced at the write, not shown on a screen** (TAR-36, TAR-405) —
  TAR-36's second acceptance criterion is "enforced, not merely displayed", and the limits now
  live in `tenant_entitlements`: one RLS-scoped row per tenant holding the whole
  `PlanEntitlements` shape, read by both the refusal and the console so a "3 of 3" and the error
  an admin just got cannot come from different stores. Nothing is hardcoded — swapping the trial
  placeholder for real plan data when TAR-37 lands is an update to those rows, not a code change
  and not an API change. Two of the five limits have a write path today. **Seats** are checked at
  invitation creation _and_ at acceptance, deliberately: creation is where the admin finds out,
  acceptance is the guarantee, and enforcing only one either surprises them a week later or lets
  two simultaneous acceptances overshoot. A seat is held by an `active` **or `suspended`** member
  plus every live pending invite — releasing a suspended member's seat would let a workspace park
  staff to dodge the cap, which is what `UserResponse.occupiesSeat` has published since TAR-166.
  The check takes a transaction-scoped advisory lock per tenant, because it is read-then-write.
  **Conversation volume** is metered on the inbound writer and refused at the **outbound send**,
  never at ingest: a customer's message is accepted and stored whatever the counter says, and what
  a spent allowance withholds is the tenant's ability to reply. That one takes no lock — it gates
  and warns and never bills, and serialising every send on one lock is the wrong trade on the
  busiest path in the product. The period is resolved in one place, and anchored on
  `tenants.created_at` rather than `trial_ends_at`, because the lifecycle clears `trial_ends_at`
  on `trialing → active` and `period_start` is part of a unique key — moving it would fork a row
  and hand the tenant a fresh allowance mid-period.
  A tenant with **no** entitlements row is uncapped, which is the correct failure direction for a
  billing ceiling rather than a security boundary; provisioning writes the row on both paths so
  that branch stays unreachable. ⚠️ `whatsappNumbers`, `teams`, `knowledgeDocuments` and the
  feature list are stored and **not** enforced — no write path refuses them yet. And the trial's
  caps are enforced before anything can be bought, so a workspace that reaches one has no route to
  a larger plan until TAR-37 ships; the refusal names a support contact rather than a checkout
  page.

- **The tenant lifecycle has one vocabulary, a schema and an audit trail — and no engine yet**
  (TAR-36, TAR-397, TAR-403, TAR-404) — three status vocabularies had been drifting since TAR-47:
  the `tenant_status` enum, `TENANT_STATUSES` in the contract package, and `admin.ts`'s
  `PROVISIONED_TENANT_STATUSES`, with a comment recording the drift as deliberate and deferred to
  this story. There is now one: `created | trialing | active | past_due | suspended | cancelled |
deleted`, with `pending` renamed to `created` (catalogue-only, no table rewrite) and
  `contract.test.ts`'s drift assertion replaced by an equality assertion so the two cannot
  separate again. Alongside it: `TENANT_STATUS_TRANSITIONS` and its seventeen legal edges,
  `LIFECYCLE_TRIGGERS`, `LIFECYCLE_POLICY`'s seven windows, `lifecycle_events` (append-only,
  platform-level, no foreign keys and no `tenant_isolation` policy, so it survives the purge and
  stays readable after the tenant it describes is shut off), `tenant_signups`, the four retention
  columns on `tenants`, their two partial sweeper indexes, and `assert_tenant_serviceable`.
  Two shapes are worth recording because they were arrived at the hard way.
  `lifecycle_events` is deliberately **not** rows in `audit_logs`: `from_state` and `to_state` are
  typed columns where `audit_logs` could only carry them inside free-form JSON, and a state
  machine whose history is untyped JSON cannot be reconstructed by a query. It shipped
  tenant-scoped and had to be un-scoped, because a composite foreign key to `users` made the purge
  impossible to finish — the purge deletes every `users` row and keeps the `tenants` row as the
  slug tombstone, so a retained event carrying `actor_user_id` blocked that delete with SQLSTATE
  23503 and could not be repaired on the way past, since the append-only trigger refuses the
  UPDATE and neither role holds DELETE. And `tenant_entitlements` replaced a narrower
  `tenant_plan_limits` that held two of the five limits and no features, and so could not populate
  the response the console was already built against.
  ⚠️ **The engine that drives all of this does not exist.** TAR-404's merged pull request
  delivered the vocabulary the engine was to be written against, not the engine:
  `TenantLifecycleService`, `TenantStatusGuard`, the five-minute sweep, the batched purge, eight
  of the nine notification templates, and every lifecycle endpoint — `GET /tenant/lifecycle`,
  cancel, undo, delete, and the four operator routes — are published in `packages/contracts` and
  unimplemented. Nothing writes `lifecycle_events`; its only rows are TAR-403's backfill.
  `assert_tenant_serviceable` exists with no callers, so `assert_tenant_active` is still the live
  gate and still refuses `suspended`. That is narrower than it sounds and the difference matters:
  a suspended tenant's inbound message is still **accepted** — Meta gets its `200` and the payload
  is stored in `webhook_events` through `SystemPrisma`, before any tenant is resolved. What the
  gate refuses is the _projection_ into `conversations` and `messages`, which runs under
  `TenantPrisma`; the processor catches `TenantNotActiveError` by name and parks the event with
  its payload intact rather than failing it. So nothing is bounced and nothing is lost — but a
  parked row is deliberately not claimable, so **a reactivated tenant does not get those messages
  back on its own**: replay is a hand-run `UPDATE` per event, and the platform-admin endpoint that
  ought to do it authorised and audited does not exist. Moving that call site is a hard gate on
  `TenantStatusGuard` existing, since the wider function with no HTTP gate behind it would hand a
  suspended tenant's agents their console back.

- **A tenant admin can see and change their own workspace, plan and seats** (TAR-36, TAR-409) —
  `/settings/workspace` renders the workspace profile, the plan and its usage, and a lifecycle
  banner for `past_due`, `suspended` and `cancelled`. The slug is shown as text rather than a
  disabled input, and says why: it is baked into the platform subdomain and into every session
  cookie scoped to that host, so changing it would break every saved link. Seat usage names its
  two parts — members and outstanding invitations — because "5 of 5 seats in use" on its own hides
  that withdrawing an invitation is the cheapest way to free one. Every lifecycle state carries a
  sentence beside its badge, so a badge never has to carry the meaning alone; `created` is written
  for a reader who should never see it, because rendering it at all means provisioning stopped
  half-way. ⚠️ The panel reads `TenantLifecycleResponse` from the mock transport, which is what
  this story was scoped to do, and the endpoint behind it is not built — see the lifecycle entry
  above. The branding fields are read-only until TAR-29 ships the editor, and the page says so
  rather than showing a colour picker that writes nowhere.

- **The tenant lifecycle, self-signup and workspace setup are documented** (TAR-36, TAR-414) —
  three new pages and a guide.
  [0012 — lifecycle state machine](docs/architecture/0012-tenant-lifecycle-state-machine.md) sits
  beside ADR 0009 and decides nothing: it holds the diagram, every edge with its trigger, the
  retention windows, the two gates, and an **as-built** column saying which edges have a writer
  today — which is the thing 0009 could not know, because it was written before the build.
  [The lifecycle reference](docs/reference/tenant-lifecycle.md) covers the two provisioning paths,
  entitlements and where each limit is enforced, what the trail records and why it is not
  `audit_logs`, and the endpoint surface split into available and published-not-implemented.
  [The signup API reference](docs/reference/signup-api.md) documents the four public routes with
  their parameters, error codes and both layers of rate limiting.
  [Set up your workspace](docs/guides/set-up-your-workspace.md) is the tenth tenant-user guide and
  the third written for an **admin**: the setup checklist, seats and the invitation that takes one
  before it is accepted, what suspension means for agents, and how reactivation works.
  The style guide gains five terminology rows — _lifecycle state_, _self-signup_, _entitlements_,
  _seat_, _purge_ — so the next writer does not have to re-decide them.
  Every page marks what is built and what is only published, because the gap between the two is
  currently large enough that a reader who assumed otherwise would write against endpoints that
  return 404. Three questions are recorded as open rather than answered: whether
  `purgeAfterSuspendedDays = 30` is confirmed, which story owns the missing `/signup` and
  `/verify` screens, and the contradiction below.
  ⚠️ Found while writing and **not fixed**, because documentation does not change application
  behaviour: `apps/web/content/en.ts` tells an admin on the People page that "Invited agents do
  not use a seat until they accept", while the seat check counts every live pending invite and
  the Workspace page says so. One of the two is wrong.

- **A tenant's own hostname can now be given TLS and pointed at the platform, and the
  operator steps for it are written down** (TAR-419) — TAR-416 settled how a custom domain
  is verified and resolved, and left the delivery half open: nothing said how a connection
  to `support.acme.com` reaches us, or where its certificate comes from. Two questions it
  flagged are now answered against Render's and Let's Encrypt's current documentation
  rather than assumed. Render **does** issue and renew wildcard certificates, over DNS-01
  with an `_acme-challenge` CNAME delegated to it — so `*.$PLATFORM_DOMAIN` is one
  certificate per environment and the per-subdomain fallback TAR-416 described is not
  needed. That matters because Let's Encrypt's cap is **50 new certificates per registered
  domain per 7 days**: a certificate per tenant would have been a 50-signups-a-week ceiling
  on the product, and the wildcard removes the ceiling rather than raising it.
  `PLATFORM_EDGE_HOSTNAME` is now declared per environment in `render.yaml` and in
  `env.schema.ts` — the bare web-service host a tenant publishes as its CNAME target.
  Prompted, not `fromService`: that property yields the _private network_ name, which no
  customer's resolver can see, and the failure would have been a CNAME that dead-ends
  rather than a deploy that fails. It is optional and has no default, because every
  plausible guess is a hostname that resolves somewhere wrong — absent, the domain routes
  must refuse a claim rather than publish an unfollowable record.
  docs/runbooks/custom-domains.md is the operator's half: the one-time wildcard setup, the
  per-tenant attach with the checks that separate a DNS problem from a certificate problem
  from a tenant-routing one, detaching, and the per-domain cost beyond a plan's allowance.
  It leads with the isolation argument, because the reassuring part is that attaching a
  domain cannot leak anything — an attached-but-unverified host serves no tenant at all —
  and the dangerous part is the one thing nothing downstream catches: attaching a
  production tenant's domain to the staging service, which resolves, and shows the customer
  a working, branded, wrong product.
  Two deliberate limits, stated rather than discovered. **Apex domains are refused**:
  `acme.com` cannot take a CNAME, and the alternatives are an `ALIAS` record many
  registrars do not offer or an `A` record baking Render's load-balancer address into every
  tenant's zone — which makes a future address change a migration we cannot perform for
  them. That also makes the `ALIAS`/`A` members of TAR-416's `DomainRoutingSchema`
  unreachable in v1; they are kept so apex support is not a contract change. And **the
  blueprint deliberately declares no custom domains at all**, wildcard included: `domains:`
  is a list, Render overwrites conflicting Dashboard configuration on sync, and whether a
  partial list prunes domains added outside it is undocumented — if it does, one unrelated
  sync drops every white-label customer's TLS with no failed deploy to point at. The
  experiment that would settle it is written down in the runbook.
  ⚠️ Attaching a domain stays a manual Dashboard step. Render has an API for it and nobody
  has integrated it here, so a verified domain waits until someone looks; the runbook asks
  for a daily digest of domains verified over 24 hours ago with no activation. The
  `/api/v1/admin/domains*` endpoints the procedure calls are TAR-420's and are not deployed
  yet — until they are, that queue is a message from the tenant.

- **A new ticket nobody's rule claimed now goes to whoever has least, and agents take turns**
  (TAR-23, TAR-273, TAR-274) — ADR 0007 published a `FallbackAssignmentResolver` seam and
  bound nothing behind it, so every ticket no rule matched was deferred with "nobody
  available". `RotationFallbackResolver` fills it in, to ADR 0008. Eligible agents are ordered
  `active_count ASC, coalesce(id > cursor, false) DESC, id ASC` and the first one under their
  cap takes the ticket. That composition is one `ORDER BY` and it is deliberately not two
  modes with a switch: with everyone equally loaded — the ordinary morning — the first key is
  a no-op and this **is** round-robin, which is what the acceptance criterion literally asks
  for; the moment loads diverge because one agent's tickets are slow to close, work goes to
  whoever has least. Nothing configures which. The ring is `users.id` ascending, and since ids
  are UUID v7 that is join order, so rotation reads as "round the team in the order people
  arrived" and survives a rename.
  **Eligibility is four predicates where the story named two**: the account is `active`, the
  agent set themselves `available`, they are under their cap — and `last_seen_at` is inside a
  15-minute presence window. The third is the addition, and it is the one worth arguing:
  `availability` is only ever written by the agent, so somebody who set themselves available
  on Monday and shut the laptop would otherwise keep drawing a share of every ticket into a
  black hole. That is the worse failure of the two because it is **silent** — the tickets look
  assigned. The window is longer than the session-slide throttle, so a working agent cannot
  age out between two writes of their own session, and short enough that a closed laptop stops
  receiving work inside one coffee break.
  **The cap is `coalesce(users.max_concurrent_tickets, tenant_settings.default_max_concurrent_tickets)`,
  defaulting to 5.** Nullable-means-inherit rather than copying the default onto every user, so
  raising the tenant number moves everyone who has not been singled out. Five is defensible,
  not measured. The **tenant pool excludes supervisors** — a supervisor holds every agent
  permission, so without the role filter every tenant's supervisor is quietly put in the
  rotation and starts receiving customer tickets between doing their own job; one who genuinely
  works a queue joins the team that owns it, which is explicit and audited. Inside a team,
  membership is the statement of intent and role is not re-checked.
  **When nobody is eligible the ticket stays unassigned and is flagged**, with one of three
  reasons rather than one: `all_at_capacity` (wait, raise a cap, or take it yourself),
  `none_available` (a staffing problem) and `no_candidate_pool` (a configuration problem — an
  empty team, or a tenant with no agents). Collapsing the last two would send a supervisor
  hunting for absent colleagues who were never configured. `all_at_capacity` wins a mixed tie
  because it is the state that resolves itself as tickets close. The console side is **Flagged
  for you** on **Settings → Assignment**: the queue, the reason on every row with the remedy
  beside it, and an assign dialog that deliberately does **not** hide agents who are at their
  limit or away — the reason the ticket is there is that nobody passed those tests, so a
  filtered picker would be empty exactly when it is needed.
  Three costs, stated rather than discovered. **The cap is exact only at worker concurrency 1**:
  the resolver decides and the engine writes, no lock spans the two, so raising concurrency or
  running two API processes makes the cap approximate — overshoot bounded by concurrent workers
  minus one, per agent, self-correcting on the next ticket. The concurrency is pinned and the
  reason is in the code. **The cursor can drift by one** when the engine's compare-and-set
  loses to a manual assignment after the cursor moved; it is a fairness hint rather than a
  ledger, and the load key corrects for it on the next ticket. And **the load count is derived,
  not denormalised** — a counter column would make selection a single scan and has to be
  maintained by every path that assigns, unassigns, resolves, closes or reopens, and a counter
  that drifts is a cap that is silently wrong, which is the failure this design exists to make
  visible.
  ⚠️ Three things ship knowingly absent. **A deferred ticket is never retried** — it waits for
  a person even if capacity frees a minute later, which matches the acceptance criterion and
  means clearing the flagged queue is real work. **Nothing rebalances**: an agent who goes
  offline holding six tickets keeps them, because taking work off a person is a supervisor's
  decision rather than a background job's. And **no surface edits a cap** — ADR 0008 specifies
  `/api/v1/assignment-settings` and `maxConcurrentTickets` on the user PATCH, both behind
  `assignment_rule:write` rather than `user:update`, and neither is built or has a story, so
  every tenant runs on the column default. The two writers that made the flag real arrived
  after this landed and have their own entries: TAR-373 for the `routing_state` write, TAR-365
  for the queue's order and its reason filter.

- **A supervisor can place a ticket auto-assignment could not** (TAR-374) —
  `POST /api/v1/tickets/{id}/assign`, on `ticket:assign`. `TicketAssignInputSchema` had been in
  the contracts package since TAR-39 and ADR 0008's endpoint table recorded the route as
  already existing; it never did, and TAR-274 built its **Assign** button against that line and
  shipped a control that 404s outside mock mode. **A schema is not a route** — the mistake was
  checking the contracts package instead of the controller, and a mock that implements the
  claimed route confirms the claim rather than testing it.
  The body is partial like the conversation's assign: `userId` and `teamId` are each applied
  only when present, so one call hands a ticket to a named agent inside the team it already
  belongs to, moves it from an agent to a team, or releases it — absent leaves the column
  alone, `null` clears it. The assignment columns, `routing_state`, both deferred columns and
  the `ticket_events` row land in **one** transaction, because
  `tickets_routing_deferred_consistent` makes the column set indivisible and an event log
  claiming an assignment the constraint then rejected would be worse than no log.
  Two decisions the specification left open are recorded as ADR 0008 amendment 2. **An explicit
  release goes to `pending`, not `manual`** — it returns the ticket to the state a fresh one
  has, keeps it out of the flagged queue because a deliberate release is not rotation failing
  to place anything, and leaves it re-routable if a re-route path is ever built, while a ticket
  a human put a name on stays untouchable. That makes **`pending` reachable after the insert**,
  which the CHECK and the queue filter both accept and which a reader would otherwise assume it
  is not. And **an assignee this tenant does not have is `validation_failed`, not 404**: the
  ticket was found, what is wrong is a field of the body, and a 404 is what a console reacts to
  by dropping the row. A user in another tenant and a user who is not `active` fold into one
  refusal, so the error cannot be used to learn that a UUID names somebody real elsewhere.
  Last writer wins, deliberately — nothing but the router writes these columns behind the
  route, and it only ever moves a ticket out of unassigned, so two supervisors racing have the
  honest answer "the later one holds it" with both on the event log. A repeated submit writes
  nothing and appends no second event, the routing columns included, so a double-clicked button
  cannot grow a second `assigned` row in the history an escalation is read from. Nothing is
  announced and no SLA job is enqueued: a timer does not move because a ticket changed hands.
  ⚠️ The mock in `apps/web/lib/api/mock/handlers.ts` answers 404 and 422 for the two assignee
  cases and now differs from the API. The console reads `error.code` rather than the status, so
  nothing in it changes.

- **Auto-assignment is documented, for the people who call it and the supervisors who clear up
  after it** (TAR-277) — `docs/reference/auto-assignment.md` is new: where rotation sits in the
  routing pipeline, the four eligibility predicates and why the third is not in the story text,
  the selection order key by key, the cursor and its accepted drift, the policy constants and
  where a cap lives, the three deferral reasons with their precedence, and the operational
  limits an owner needs — the concurrency-1 caveat, the breaking points for the derived load
  count and the un-indexed candidate scan, and what to monitor. It also states the relationship
  the issue tracker reads backwards: TAR-23 was planned as the behaviour TAR-24 would later
  override, and in the event rotation landed first, so no `NullFallbackAssignmentResolver` was
  ever bound — the seam is load-bearing in production rather than a placeholder, and the three
  obligations it places on any resolver behind that token are written down.
  `docs/reference/tickets-api.md` gains `POST /api/v1/tickets/{id}/assign`, which it had been
  carrying as a "still to do" line: parameters, the partial-update rule, what it writes to
  `routing`, the release-goes-to-`pending` rule, the repeated-submit no-op, every status and
  error code with the message it actually returns, and the two event types.
  `docs/guides/clear-flagged-tickets.md` is the same subject for a supervisor in the console,
  written against the labels on screen — what puts a ticket in the list, what each reason means
  and who can fix it, and why the assign picker shows agents who are at their limit.
  Verified rather than asserted: the unit and integration suites were run (223 and 460 tests),
  and every request, response body, status code and error message on the assign section was
  executed against a local stack.
  ⚠️ Two gaps are marked in the documents rather than papered over. There is still no surface
  for editing a concurrent-ticket cap and no story id to point a reader at, which the guide has
  to admit at exactly the moment a supervisor would want to act on **Everyone at capacity**.
  And no deferral could be produced by hand — only a routing job writes the flag — so a seeded
  tenant returns an empty flagged page and every claim about what a deferral writes rests on
  the integration specs.

- **A supervisor can say where new tickets go, and the first matching rule decides**
  (TAR-24) — `assignment_rules` has existed since TAR-47 under a comment reading "TAR-24
  owns the condition and action grammar", and nothing read or wrote it. It is filled in now,
  to ADR 0007. A supervisor writes "if the message mentions billing, send it to the Billing
  team" in **Settings → Assignment**, orders the rules, and the next matching ticket lands
  there instead of in the rotation. Six routes under `/api/v1/assignment-rules` — list,
  create, read, update, delete and `reorder` — on the `assignment_rule:read` /
  `assignment_rule:write` that `rbac.ts` has shipped since TAR-39. **No new error code and
  no new permission**, and deliberately not `channel:manage`, which is admin-only and would
  take routing out of a supervisor's hands.
  **Four condition types, combining with AND inside a rule and with OR by being a list**:
  words in the message, a contact tag, business hours, and a contact custom field. There is
  no rule-level any/all toggle and no nested tree — an ordered first-match list already
  expresses OR, and a grammar the form cannot build is one the API has to keep validating
  for ever. Empty `conditions` is refused: a rule matching everything, placed anywhere but
  last, silently swallows all routing, and the thing it would express is already the
  fallback.
  **Evaluation is `ORDER BY position, id`, first match wins, once per ticket at creation.**
  The `id` tie-break is load-bearing rather than cosmetic — `position` defaults to `0` with
  no unique constraint, so without it two rules created normally have no defined order and
  "which rule wins" would depend on the query plan. Routing runs off a BullMQ job enqueued
  after the ticket transaction commits, so a bug in rule evaluation cannot roll back a
  ticket; the cost, stated, is that assignment is eventually consistent with the ticket and
  any UI assuming a ticket is born assigned is wrong. The write is a compare-and-set bounded
  to `assigned_user_id IS NULL AND assigned_team_id IS NULL`, which is both what makes
  at-least-once delivery safe and what stops a rule silently undoing a supervisor's manual
  assignment made a second earlier.
  **A matched rule is terminal**, and **a rule whose target cannot take work is treated as
  not matching** — a suspended agent or a team with no active members is skipped with a
  warning naming the rule, and evaluation continues, because putting the ticket in front of
  rotation immediately beats assigning it somewhere invisible. **No match calls TAR-23's
  rotation**; when rotation has nobody the ticket stays unassigned, records an
  `assignment_deferred` event with the reason, and surfaces under **Flagged for you**.
  Bad tenant data never throws: a rule whose stored conditions do not parse, an unparseable
  business-hours column, a contact with no tags — each makes a condition false and the rule
  falls through. The failure mode of a routing engine has to be "this ticket went to
  rotation", never "this ticket went to the wrong team" and never "the queue stopped".
  Schema delta from TAR-285: `name` becomes `citext` with `UNIQUE (tenant_id, name)` because
  the rule name is what the ticket event names; a conditional CHECK gives every **active**
  rule exactly one target while still permitting the target-less inactive rule that user
  removal deliberately leaves behind; the index gains `id`; and `action Json` is dropped, as
  two representations of one fact with no owner. Writes are audited as
  `assignment_rule.created`, `.updated`, `.deleted` and `.reordered`, with the name and
  target in metadata and **never the conditions** — a contact-field value is tenant data and
  can carry personal information.
  Documented in [the assignment rules API reference](docs/reference/assignment-rules-api.md)
  and, for supervisors, [Route new tickets to the right team](docs/guides/route-new-tickets-with-rules.md).
  ⚠️ Three things are stated rather than fixed. A contact who has never had a custom field
  written is treated as unanswerable rather than empty, so an "is empty" rule does not match
  a brand-new customer (TAR-370). `tag` condition ids are not validated against the tenant on
  write, so a rule naming a deleted tag is accepted and then never fires (TAR-370). And
  selecting more than 25 tags on one condition is refused with a generic message rather than
  a field-level one (TAR-371). Business hours themselves still have no console surface: the
  column is written by provisioning and the seed only, so a `business_hours` condition never
  matches until somebody sets them — which is why an unconfigured tenant evaluates the
  condition false either way rather than being guessed as always open or always closed.

- **A ticket nobody answers in time now goes overdue on its own, and a supervisor is told**
  (TAR-280) — TAR-47 landed `sla_policies` and `sla_timers` and TAR-73 published
  `TicketSlaSchema`; nothing read or wrote any of it, no timer was ever created, and
  `tickets.first_response_at` had never been written by any code path. The mechanism exists
  now, built to ADR 0006. A new L4 `SlaModule` starts a first-response timer when a ticket
  opens, pauses it while the ticket waits on the customer, resumes it — with the deadline
  moved forward by however long the pause lasted — when they reply, and stops it as `met`
  the first time a **person** answers. A bot reply writes no `sender_user_id` and therefore
  does not stop the clock, which is a decision recorded rather than an accident of whichever
  path writes the message.
  **Detection is a repeatable sweep every `SLA_SWEEP_INTERVAL_MS`, not a job scheduled per
  timer.** A delayed job is precise to the second and stores the deadline in Redis, which
  this codebase treats as losable: a flush would lose breaches with no error, no retry and
  no failed set — an alert that simply never comes. The deadline lives in Postgres, the
  predicate is `due_at <= now()` rather than "due since the last tick", so an outage of any
  length makes alerts _late_ rather than _absent_ and the first sweep afterwards drains the
  whole backlog. `due_at` also moves on every pause, and a stale scheduled job that escaped
  cancellation would fire early — a **false** breach, which is worse than a late one. Cost,
  stated: detection latency bounded by the interval, 30 s against a 60-minute window.
  **Exactly one alert per breach, by construction rather than by checking.** The sweep's
  claim is a conditional `UPDATE … WHERE state = 'running'` and only the rows it moved are
  alerted, so two replicas sweeping the same timer produce one alert and one `sla_breached`
  ticket event — the audit row is written in the same transaction as the flip precisely
  because `ticket_events` has no unique constraint to fall back on. `UNIQUE (tenant_id,
sla_timer_id, recipient_user_id)` is the second layer; only the first is load-bearing. A
  BullMQ job id was specified as a third and **is not shipped** — keyed on the ticket, whose
  id is stable for its whole life, it collapsed every trigger into the completed key of the
  one before it and silently dropped the reply that should have stopped the timer. Anything
  reintroducing one must key it on the event, never on the ticket.
  Recipients are derived from TAR-22's model as it stands — the tenant's active supervisors
  and admins, narrowed to those sharing a team with whoever holds the ticket, falling back to
  all of them when that yields nobody. A broad alert is worse than a narrow one; an alert
  delivered to nobody is worse than both. Each gets a durable `sla_alerts` row **and** an
  `sla.breached` push to their own user room, because a supervisor offline at 02:14 must
  still learn about it: the row is the record, the socket is the accelerator.
  New surface: `GET`/`PATCH /api/v1/sla-policies` under the existing `sla:read`/`sla:write`,
  and `GET /api/v1/sla-alerts` plus `POST /api/v1/sla-alerts/{id}/acknowledge` under
  `ticket:read` — no new permission and no grant moved. The alert list needs no `_all`
  permission because every row names its recipient and the query narrows to the calling
  principal on top of RLS; an agent may call it and gets an empty page, and another
  supervisor's alert answers `not_found` rather than `forbidden`.
  Documented in [the SLA timers reference](docs/reference/sla-timers.md) and, for supervisors,
  [Watch tickets that miss their deadline](docs/guides/track-overdue-tickets.md). Two defects
  found in post-merge review are corrected below under **Fixed** (TAR-380, TAR-381), and both
  changed behaviour this entry describes.
  ⚠️ Two things are stated rather than built. Business hours stay modelled and unimplemented
  (`business_hours_only` is always false), so a timer started at 17:30 breaches overnight —
  ADR 0006 risk 1, and its own story if any tenant's SLA is contractual against working
  hours. And nothing re-enqueues a lost evaluation trigger: a ticket whose trigger was lost
  gets no timer until something else evaluates it, which a sweep for
  ticket-with-no-timer would close.

- **An agent can move a ticket through its life, and the queue puts urgent work first**
  (TAR-284) — `tickets` has carried a status, a priority and a `resolved_at` column since
  TAR-21, and nothing wrote them: there was no endpoint, so a ticket opened by a customer's
  first message stayed open for ever. `PATCH /api/v1/tickets/{id}` is that write — subject,
  status and priority in one call, because a status change and a re-prioritisation are one
  triage action an agent takes in one form. `GET /api/v1/tickets` and
  `GET /api/v1/tickets/{id}` publish the queue and one ticket beside it.
  **Resolving a ticket takes it out of the queue with no client change**: the list defaults
  to the active statuses (`open`, `pending`), so a resolved ticket stops matching, and its
  `resolved_at` is stamped on the way in. **Urgent sorts to the top** —
  `priority DESC, created_at DESC, id DESC`, with no sort parameter, served by a new partial
  index `tickets_active_queue_idx` so the page carries no sort over the tenant's active set.
  That order rests on `ticket_priority` being declared `low, normal, high, urgent`, which is
  load-bearing and invisible, so `schema.prisma` warns and an integration test asserts it.
  `resolved` and `closed` are terminal: re-activating either is `conflict`, because
  `tickets_one_active_per_contact` would refuse the row anyway and there is no reopen window
  at v1. `open → closed` is allowed and does **not** back-fill a resolution time — closing
  spam is not resolving it, and cycle-time reporting reads that column. Setting the value a
  ticket already holds is a 200 no-op that writes no event, not a 409: a double-clicked
  button achieved what was asked. Every change appends one `ticket_events` row carrying
  `{ from, to, cause }`, where `cause` is new on `TicketEventSchema` and is how a client
  tells an agent reopening a ticket by hand from the customer reopening it by replying.
  The write is a compare-and-set on `status`, the same shape `TicketLinkerService` already
  used, so the two writers cannot corrupt each other: the customer's reply landing mid-resolve
  answers `conflict` and sends the console to a refetch rather than silently resolving a
  ticket the customer just added to. Terminal moves additionally need `ticket:close`,
  checked per-body in the service because the guard is per-route. Recorded as ADR 0002
  amendment 9.
  ⚠️ Not wired: `realtime.ts` publishes `ticket.updated` and nothing emits it, so an
  auto-reopen becomes visible on the console's next refetch rather than being pushed. The
  domain event exists; the socket relay is a subscriber away and needs a ticket audience
  room, which a status-change story deliberately did not amend.

- **The ticket queue and the ticket view** (TAR-286) — the console side of the same story.
  `/tickets` lists work urgent-first with Status, Priority and Scope filters and says what
  the order is, because it is not a control; `/tickets/{id}` shows the ticket, its
  conversation and its status and priority controls. Status is a row of verbs — one per move
  `TICKET_STATUS_TRANSITIONS` allows out of the current status, so a closed ticket renders
  none and nothing on screen can produce a transition the API refuses — while priority is a
  select, because it is a value rather than an act and it is reversible. Resolving and
  closing are confirmed first and the copy names what happens instead of asking "are you
  sure?", since neither is undoable at v1. Controls are permission-gated, and a role that
  may re-prioritise but not finish work is told so rather than shown a screen with nothing on
  it. A ticket the reader may not see renders as unavailable, matching the API's `not_found`.
  A `status_changed` carrying `cause: 'inbound_message'` reads as "Reopened — customer
  replied".

- **Ticket status and priority are documented** (TAR-295) —
  `docs/reference/tickets-api.md` for engineers (the three routes, the transition table, the
  no-op rule, the timestamps, every error and the isolation guarantees, verified against a
  local stack) and `docs/guides/manage-ticket-status-and-priority.md` for agents working in
  the console. The first tenant-user document in the repository; `docs/STYLE.md` gains the
  rule it is written under.

- **A supervisor's routing rules now decide where a new ticket goes** (TAR-288) — ADR 0007
  published the grammar, the evaluation order and the fallback seam; TAR-285 shipped the
  schema. This is the code between them. Six routes under `/api/v1/assignment-rules`, gated
  on the `assignment_rule:read` / `assignment_rule:write` pair `rbac.ts` has carried since
  TAR-39 — not the admin-only `channel:manage` the issue text proposed, which would have
  made routing an admin surface and contradicted TAR-22's third acceptance criterion. The
  list does not paginate and says so in its shape, keeping `nextCursor` fixed at `null`:
  `rulesPerTenant` is enforced on create, so a bounded response is a promise the server can
  actually keep. Reorder takes the tenant's **complete** set rather than a delta, which
  buys optimistic concurrency for free — a set that is not exactly the current one means
  another supervisor edited the list, and the answer is `conflict` rather than a silent
  partial reorder. Delete is idempotent and leaves the surviving positions alone, because
  the order is the sort and not the values.
  On the engine side, a created ticket is enqueued onto a new `assignment` queue after its
  transaction commits, and the worker evaluates the active rules in `(position, id)` order
  with the first match winning. The `id` tie-break is load-bearing rather than cosmetic:
  `position` defaults to `0` and carries no unique constraint, so without it two rules
  created normally would have their order decided by the query plan. A matched rule is
  terminal — it assigns its team or user and does not then run rotation inside that team —
  and a rule whose target is a suspended user or a member-less team is treated as not
  matching, so evaluation continues rather than parking the ticket somewhere nobody can
  see it. When nothing matches, the engine calls `FallbackAssignmentResolver` and stops
  there; TAR-23 fills that binding in, and until it does `NullFallbackAssignmentResolver`
  answers "nobody available", which means a ticket no rule matches stays unassigned and is
  flagged with an `assignment_deferred` event rather than being silently unowned.
  Two properties are worth knowing because they are deliberate. The assignment write is a
  **compare-and-set** bounded to an unassigned ticket, in the same transaction as the
  `ticket_events` append — so a redelivered job is a no-op, and a supervisor who assigns by
  hand in the second before the worker runs keeps their assignment rather than having a
  rule silently undo them. And **bad tenant data never throws**: a rule whose stored
  conditions do not parse, an unreadable `business_hours` column, a ticket with no contact
  or no message — each makes a condition false and evaluation continues, because the
  failure mode of a routing engine has to be "this went to rotation", never "this went to
  the wrong team" and never "the queue stopped".
  `isWithinBusinessHours` is published in `@whatsappcrm/contracts` alongside the shape
  `tenant_settings.business_hours` has carried since TAR-47 and never had an interpreter,
  which narrows ADR 0006's risk 1 to the holiday calendar it left open. Both daylight-saving
  transitions are covered: neither needs a special case, because working from the formatted
  wall clock means a skipped hour simply contains no instants and a repeated one contains
  two runs of them. One deviation from 0007's transcript, called out in the code: Zod 4
  made an enum-keyed `z.record` exhaustive, so `BusinessHoursSchema` uses `partialRecord` —
  the document's literal spelling would have refused the seeded tenant, which lists `mon`–
  `fri` and no weekend. Rule writes are audited as `assignment_rule.created/.updated/
.deleted/.reordered`, carrying the name and target and never the conditions, which can
  hold tenant PII.

- **Routing rules are documented, for both the people who call them and the people who
  write them** (TAR-292) — `docs/reference/assignment-rules-api.md` covers the six
  `/api/v1/assignment-rules` routes end to end: authentication, the permission pair, the
  condition grammar with the semantics a reader cannot derive from the schema, every status
  and error code, the audit rows, and the whole evaluation path from the `assignment` queue
  job to the `ticket_events` row that records why a ticket went where it did.
  `docs/guides/route-new-tickets-with-rules.md` is the same subject for a supervisor in the
  console — the rule list, the order, the on/off switch, and what happens when nothing
  matches — written against the labels on screen and naming no type, module or endpoint.
  Two documents rather than one, because a page written for both readers serves neither.
  The `assignment_rules` entry in the data-model reference was stale from TAR-285 and is
  corrected: the dropped `action` column, the `(tenant_id, name)` citext uniqueness, the
  index that now carries the `id` tie-break, and the conditional CHECK that Prisma cannot
  express. Two places where the shipped behaviour differs from ADR 0007 are stated rather
  than papered over — a duplicated id in `reorder` answers `conflict` rather than
  `validation_failed`, and no `NullFallbackAssignmentResolver` is bound because rotation
  landed first — as are the open defects a reader would otherwise mistake for their own
  mistake: `is_not_set` not matching a contact that has never had a custom field written,
  and `tag` ids going unvalidated on write (both TAR-370).
  ⚠️ One gap is marked in the guide rather than answered: there is no console surface and no
  tenant-facing endpoint for setting business hours, so the guide cannot tell a supervisor
  where to configure the thing a `business_hours` condition reads.

- **A template an agent cannot find is now explained rather than absent** (TAR-91) —
  `GET /api/v1/message-templates` deliberately hides two kinds of template from the
  composer's picker: the ones Meta has not approved, and the ones whose buttons need a
  send-time parameter this build cannot supply. Amendment 1 accepted both on the promise
  that a template-administration surface made them visible, and that surface did not exist,
  so the mitigation was a sentence in a document. It exists now:
  `GET /api/v1/whatsapp/message-templates` under `channel:manage` returns **every** template
  the tenant holds, whatever its Meta status, each carrying `sendable` and a `sendBlockers`
  list — `meta_not_approved`, `button_parameters_required`, or both where both apply. That
  distinction is the point: _Meta has not approved this yet_ and _we cannot send this yet_
  are different problems with different owners, and a template that is simply missing from
  one list says neither. Filters by business account, Meta status and name prefix; read-only,
  because template authorship stays in Meta's own tooling.
  A separate route rather than a `status` parameter on the composer's list, so neither
  surface can be turned into the other by a query string, and the exclusion rule itself is
  now one function (`messageTemplateSendBlockers`) that the picker filters on and this
  surface publishes — two copies would eventually disagree, and the silent direction is
  reporting a hidden template as fine. Adds
  `message_templates (tenant_id, name, language, id)`; the picker's index leads with `status`
  and cannot serve an unfiltered read in sort order. Recorded as ADR 0002 amendment 8.
  ⚠️ Still open, and now written down where the code is rather than left as a pending
  to-do: whether `quick_reply` belongs on `PARAMETERLESS_BUTTON_TYPES`. Meta's send-side
  documentation — the only page that states whether a `button` component is required in a
  send — has returned HTTP 500 on every attempt across four builds, so it is settleable by
  one live send against a connected WABA and by nothing else. `quick_reply` stays out
  (fail-closed, cost: a sendable template missing from the picker, which this surface now
  explains); `voice_call` stays in as a stated accepted risk rather than an unverified entry.

- **Routing-rule contract** — `docs/architecture/0007-routing-rules-and-assignment-fallback.md`,
  with amendment 7 to ADR 0002 for the six `/api/v1/assignment-rules` routes. Fixes the
  condition grammar (`keyword`, `tag`, `business_hours`, `contact_attribute`, combined with
  AND inside a rule and OR across the ordered list), the evaluation order
  (`position ASC, id ASC`, first match wins, a matched rule terminal), the five schema deltas
  against TAR-47's `assignment_rules`, and `FallbackAssignmentResolver` — the seam TAR-24's
  "no rule matched" path calls and TAR-23 implements behind, so the rule engine can be built
  and tested against a stub before rotation lands. Also formalises
  `tenant_settings.business_hours`, which has had a shape since TAR-47 and no interpreter.
  (TAR-279)

- **Auto-ticket creation now fires on real conversations** (TAR-77) — TAR-75 built the
  ticket linker and proved it against fixtures; TAR-73 published the contract the two sides
  meet over; nothing called either on production traffic. This connects them. Once an
  inbound message has committed, `WhatsAppInboundWriter` enqueues
  `ticket.ensure-for-message` on the `tickets` queue, and `TicketQueueRunner` — new, and the
  only file in `TicketsModule` that knows a queue exists — hands it to the linker inside the
  tenant scope `QueueService` opened from the job payload. A customer writing in for the
  first time gets an open ticket linked to their conversation; their next message attaches
  to it instead of opening a second one; a reply to a `pending` ticket reopens it, and one
  written after the ticket was resolved correctly starts a new one.
  **The two modules still never import each other.** `WebhooksModule` is L2 and
  `TicketsModule` is L3, so what crosses the line is the payload shape in
  `@whatsappcrm/contracts` — and the queue, not a call, so a fault in the ticket module
  produces tickets late rather than rolling back the customer's message. The cost is stated
  rather than hidden: the ticket is eventually consistent with the message, and a queue
  outage means a message with no ticket yet.
  **The trigger is enqueued for a replay too**, not only for a message this delivery was
  the first to write. The message write and the trigger are deliberately not one atomic
  unit, so a worker that commits the message and then dies leaves a message with no ticket,
  and the webhook sweeper's replay is the only thing that will ever revisit it — on which
  `skipDuplicates` writes nothing, so the id is read back rather than taken from the insert.
  Without that, exactly those messages would silently never become tickets. Only inbound
  messages are sent: the outbound placeholder a delivery receipt creates would be skipped by
  the linker anyway, and a job whose one outcome is `skipped` buys nothing.
  A malformed payload fails unrecoverably rather than spending five attempts on a shape that
  cannot change; a deactivated tenant is discarded rather than retried; everything else is
  retryable, bounded by the new `TICKET_LINK_MAX_ATTEMPTS`. Verified end to end against a
  real PostgreSQL in `auto-ticket-pipeline.int-spec.ts`, including that the same customer
  number writing to two tenants gets two tickets neither tenant can see the other half of.

- **The inbox can reply: a composer that knows which of WhatsApp's two send modes it is in**
  (TAR-72) — the thread gains a reply box, and the interesting part is that there are two of
  them behind one control. Inside Meta's 24-hour customer service window an agent writes what
  they like; outside it WhatsApp accepts only a template the business had approved, so the
  free-form control goes inert — **disabled, not removed**, because removing it would throw
  away a half-typed draft and leave nobody to explain why — and the template picker becomes
  the way through. `features/inbox/service-window.ts` mirrors the API's own rule rather than
  inventing one: `null` means closed, the boundary is exclusive, and no duration lives on this
  side. The state is computed on the server and handed down as `initialWindow`, so the first
  client render matches the markup that arrived, and `useServiceWindow` then schedules a timer
  for the moment it shuts — which is the whole point: the window used to be discovered by
  pressing Send and reading `whatsapp_window_expired`, and now the composer switches under the
  agent's hands with the draft still on screen and a toast saying so. The countdown re-phrases
  on a timer through `Intl.RelativeTimeFormat`, so a banner left open on a second monitor is
  not quietly an hour stale.

  **A send cannot be recalled, so the double-send guard is the feature.** Every send carries
  an `Idempotency-Key`, and `useIdempotencyKey` mints it **per payload and retires it the
  moment a send lands** — two rules, because the API enforces two things: an identical body
  under the same key replays the original message, and a _different_ body under it is refused
  as `idempotency_key_reused`. Per payload alone is wrong in a way that costs a message. The
  draft clears on success, but the _next_ identical reply hashes the same, so `ok` twice in a
  row would spend a key that had already delivered, replay the first send's 201, and reach
  nobody — while the console said "Message sent" and cleared the box. Keys live 24 hours, and
  short repeated replies are ordinary support traffic. A key held constant would block an agent
  fixing a typo and retrying; a key minted per click would let a double-click through as two
  messages. Keying on the draft and dropping it on delivery covers all four: a double-click and
  a retry after a network drop deduplicate, an edit gets a fresh key, and so does a repeat.

  Template filling is decided before the send, not after it: `template-draft.ts` checks arity
  and the header rule 0002 amendment 1 states — a header exactly when the template publishes
  one, formats agreeing — so the Send button never reaches a `whatsapp_template_invalid` a
  person cannot act on. All four header formats are supported, with a media header reusing the
  same attach control the free-form box uses, narrowed to the one kind Meta approved. The
  preview goes through the contract's `renderTemplateBody`, now published from
  `packages/contracts` and re-exported by the API's validator rather than implemented twice —
  a console promising one sentence while the customer receives another is the one thing a
  record of a conversation must never do. Media uploads leave from the browser to the
  same-origin `/api` proxy instead of through a server action, because WhatsApp's document
  ceiling is 100 MB and buffering that in the console's memory would move bytes that are going
  to the API anyway; the file is checked against the contract's `WHATSAPP_MEDIA_LIMITS` before
  the upload is spent, and spent on pick rather than on send, so Send stays a small JSON call.
  The picker is behind `next/dynamic` and confirmed to be its own chunk. `run-action.ts` now
  treats `whatsapp_window_expired` and `whatsapp_template_invalid` as actionable, so their
  messages reach the agent instead of being flattened into "we could not save that", and the
  mock transport gained the send route — idempotency replay, key reuse and the closed window
  included — so the guard can be exercised in review rather than assumed.

- **A ruled visual design language, and a console frame to match**
  (TAR-202) — `docs/design/0001-visual-design-language.md` records what the design tokens
  equal and what the recurring layouts are, the same way 0002 records the API contract. The
  token layer gains the values behind it: a green accent whose every pair is measured
  against WCAG AA in both themes, a navy family for the navigation rail, an 8px rhythm with
  4px half-steps, 6–8px radii, softer shadows, and Figtree self-hosted through `next/font`.
  The console's frame changes with it — the top nav bar becomes a fixed, collapsible
  icon-and-label rail beside a top bar carrying identity and utilities, with the collapsed
  width stored in `wac_rail` and read on the server so the frame is the right size in the
  first HTML response. Three shared components carry the new patterns: `Icon`, `Tabs` (the
  settings sub-navigation now uses it) and `FilterPills` (the inbox scope strip now uses
  it). Below 48rem nothing changes for the user: the rail is removed outright and the
  existing focus-trapped drawer is still the navigation, rendering from the same single nav
  data source.
- **The shared inbox has a screen: a live conversation list beside the thread, with its
  media, its notes and the claim** (TAR-71) — `/inbox` becomes master-detail. Scope, status
  filter and the open conversation all live in the URL, so a refresh, a copied link and the
  back button reproduce the same view; the two panes are one CSS switch on a data attribute,
  so a phone shows the list until a conversation is picked and then the thread with a real
  link back, and nothing measures a viewport in JavaScript. The thread renders text and all
  four media kinds in both directions from `MessageAttachment.kind`, never from the media
  type — `image/webp` is a sticker and `image/png` is a photo, and they do not render the
  same way — and it renders the two states an inbound attachment can be in before it is
  `stored`: `pending` gets a placeholder **in the box the picture will occupy**, `failed`
  says so, because the customer did send something and a silent gap would say otherwise. A
  type nothing can draw — a location, a shared contact — gets a labelled row rather than a
  hole in the conversation. Internal notes get their own panel that says, above the list and
  again on the field, that the customer never sees them; the guarantee is structural (a note
  is a separate entity and no send path can reach one) but it is invisible to the person
  typing. Claiming is three states, not two: the shared pool gets a **Claim**, a thread you
  hold gets a **Release**, and one a colleague holds gets **Take over** behind a
  confirmation that names them and says what it costs them — because the API writes the
  assignment unconditionally (TAR-186 has since made the claim a compare-and-set; a
  take-over stays blind on purpose), so presenting a takeover as
  a claim quietly moved work off the person doing it. TAR-198 now puts the hand-over on that
  person's socket, so their inbox follows it; what the confirmation says is that nothing
  _interrupts_ them, and they may be part-way through a reply. Outbound authorship reads `MessageResponse.sentByAutomation` rather than
  a failed name lookup, so an agent whose name falls outside the directory's single page is
  "sent by a teammate" and never "sent automatically" — misattributing a colleague's words
  to a bot is a lie about the one thing this product is a record of. Realtime is TAR-69's
  socket, and the console's rule is that **an event is a signal to refetch, never state to
  apply**: `router.refresh()` re-runs the same visibility checks
  the API enforces, so a thread that changes hands cannot leave a stale copy on screen and a
  reconnect recovers full state with no replay to miss. Socket.IO's own reconnection is off
  because the handshake ticket is single-use and it would replay a spent one for ever;
  `socket.io-client` is imported dynamically and stays out of the route's initial JavaScript.
  ⚠️ **The console now offers every scope to every role.** ADR 0002 amendment 4 rules an
  unclaimed conversation visible to every agent on the tenant, and the API opens
  `scope=unassigned` accordingly, so hiding the tab left arriving customers unanswered;
  `scope=all` is offered too and the narrowing it gets for a principal without
  `conversation:read_all` is said out loud rather than left to be discovered. Claiming
  needed `conversation:assign` as shipped here, which an agent does not hold — TAR-186 has
  since given every role a `conversation:claim` and the control is theirs.
- **The shared inbox has an API: nine routes, the 24-hour window rule, and idempotent
  sending** (TAR-68) — `ConversationsModule` implements TAR-39's Inbox surface end to end.
  Reads are keyset-paginated on `(last_message_at DESC, id DESC)` over TAR-80's three
  scope-carrying indexes, and every route that names one conversation goes through a single
  visibility check, so a thread the caller may not see answers `not_found` rather than
  `forbidden` — never confirming that an id names a real conversation somebody else is
  handling. The send endpoint checks `conversations.service_window_expires_at`: inside the
  window a free-form message is accepted, outside it only a template that is **approved on
  that number's business account**, with its variables and its header slot checked against
  Meta's own component tree before the Cloud API is called — because every one of those
  failures otherwise comes back as an opaque provider error, after the message row exists.
  A send creates the row `queued` and returns; delivery is a BullMQ job guarded on
  `status = queued`, so a worker that crashed after Meta accepted the send produces lateness
  rather than a second message to the customer, and only "Meta is unreachable" or "Meta is
  throttling" are retried. `Idempotency-Key` is required on the send and implemented as
  0002 rules it — the key is claimed **before** the work runs, so two requests arriving in
  the same millisecond are decided by the unique index on `(tenant_id, key)` rather than by
  a check that both of them pass. An unclaimed conversation is visible to every agent on the
  tenant, which is the one place this widens a rule 0004 shipped; the reasoning, and the
  three other questions the endpoint table did not answer, are ruled in
  [amendment 4](docs/architecture/0002-architecture-and-api-contract.md#amendment-4--the-shared-inbox-tar-68).
  `conversation_status` gains `closed` (`20260811170000_conversation_status_closed`,
  additive and re-runnable), which the contract has published since TAR-39 and the enum
  never carried — so a status update the schema called valid reached the database as an
  invalid label.

- **The inbox updates itself: a Socket.IO gateway, its rooms, and the relay that feeds
  them** (TAR-69) — `RealtimeModule` attaches a Socket.IO server to the API process at
  `/realtime` and turns the domain events the ingestion pipeline and TAR-68's send path
  already emit into `message.created` and `message.status_changed` on the wire. The
  handshake spends the single-use ticket TAR-180 issues, and then does the thing the ticket
  alone cannot: it re-reads the session by id (`SessionService.resolveBySessionId`, new) so
  a sign-out inside the ticket's sixty seconds is honoured and a role change is picked up
  rather than served a minute stale — the socket authorises `conversation.subscribe` on
  `permissions` and `teamIds`, so a frozen copy would be a frozen authorization. That
  lookup runs on `TenantPrisma`, which makes RLS rather than a comparison the thing that
  stops a ticket minted in one tenant resolving a principal in another; it deliberately
  does **not** slide the idle deadline, because an open tab is not evidence anybody is at
  the keyboard. Rooms are joined from the server's view only: `tenant:{id}` and `user:{id}`
  come from the resolved principal, and the single client-supplied identifier anywhere in
  the gateway is a conversation id, which `ConversationAccessService` checks against RLS
  _and_ `isVisibleOrUnclaimed` — the same predicate TAR-68's routes apply, so the socket
  and the REST surface answer identically for an unclaimed thread — before joining
  `conversation:{id}`. Refusals are uniform, so the channel is not an oracle for which ids
  exist. Payloads are whole `MessageResponse` resources rather than deltas, built by
  TAR-68's own `MESSAGE_PROJECTION` and `toMessageResponse` rather than a second copy, and
  made absolute through the `ResponseOriginService` that module's doc invites a second
  declarer for. The origin the socket path publishes comes from the tenant's primary
  **verified** domain in the control plane, on `TenantLinkService`'s reasoning: a WebSocket
  upgrade carries no host worth believing. `RealtimeIoAdapter` supplies CORS from
  `WEB_ORIGIN` and, where `REDIS_URL` is set, a `@socket.io/redis-adapter` pub/sub pair —
  without it an event emitted on one replica reaches only that replica's sockets, which is
  a silent failure rather than a slow one, so its absence is warned about at boot. The
  publisher in that pair gets a command timeout and one retry rather than the subscriber's
  `maxRetriesPerRequest: null`, which the two previously shared through `duplicate()`: an
  untimed publisher buffers every room emit in ioredis's offline queue for the length of a
  Redis outage, growing with inbound message volume and logging nothing, because a command
  that never settles never reaches the relay's `catch`.

- **The realtime fan-out is the visibility rule, not the tenant** (TAR-69 review,
  [amendment 5](docs/architecture/0002-architecture-and-api-contract.md#amendment-5--the-realtime-fan-out-is-the-visibility-rule-tar-69))
  — as first published, every message event went to `tenant:{id}`, so an agent received the
  body, provider id and attachment URLs of conversations `GET /conversations/{id}` answers
  `not_found` for on the same principal, in the same tenant. The implementation was faithful
  and the published fan-out was wrong, so the contract is amended rather than locally worked
  around. The room vocabulary gains `tenant:{id}:conversation-readers` and `team:{id}`, and
  `conversationAudienceRooms` publishes the audience as one room per branch of
  `isVisibleOrUnclaimed`: readers always, the assignee or the routed team when there is one,
  and the tenant-wide room **only** while a thread is unclaimed — which is exactly the case
  amendment 4 rules every agent may see. The set is derived from the conversation's current
  assignment on every emit rather than joined once, so a thread changing hands changes
  audience on the next event with no stale membership to reconcile; `conversation:{id}` is
  deliberately not in it, since a subscription authorised while a thread was unclaimed must
  not survive somebody claiming it. Also closed: `session.revoked` → `user:{id}` was
  published so an open tab logs out, and nothing emitted it — a WebSocket authenticates once
  and has no next request to be refused on, so an agent an admin suspended kept a live
  socket until the tab closed, bounded only by the 30-day absolute session cap. Every
  revocation path now announces through the one after-commit hook they all share, and the
  gateway re-reads each of that user's sockets rather than trusting the announcement,
  because a signed-in password change spares one session and a single-device sign-out kills
  exactly one. ⚠️ Still not relayed: `message.attachment_settled` and `ticket.created`,
  which are emitted today but have no server event in the contract, so an inbound picture's
  spinner still stops on a refetch.

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
- **Agent, team and role management API** — `GET /api/v1/users` (tenant-wide, keyset
  paginated, filterable by role, status, team and free text), `PATCH /api/v1/users/{id}`,
  `POST /api/v1/users/{id}/unlock`, `DELETE /api/v1/users/{id}`,
  `PATCH /api/v1/users/me/availability`, and `GET`/`POST`/`PATCH /api/v1/teams`. Every route
  states a permission and `PermissionGuard` denies by default, including the one that needs
  none. Two things permissions cannot express are enforced in the service and answer with
  their own message: **nobody changes their own role** and **nobody grants a role above their
  own** (`403`), and **the last active admin cannot be demoted, suspended or removed**
  (`409 last_admin_required`, a locking read over the tenant's active admins rather than a
  `count()`, so two concurrent demotions cannot both commit). `role` is gated on
  `user:set_role` **in addition to** `user:update`, and a caller without it is refused
  rather than served with the field silently dropped. `security` on a `UserResponse` is
  `null` for a caller without `user:update`, so an agent cannot read how close a colleague
  is to lockout. `DELETE` is a soft delete — `status: 'removed'`, sessions killed, team
  memberships dropped, conversation, ticket, assignment-rule and round-robin references
  cleared, live invitations revoked — because four of the tables referencing `users` are
  history, and `audit_logs` among them. Removed accounts are absent from the list unless
  asked for by name. Every mutation that changes what somebody may do revokes their sessions
  in the same transaction and purges the principal cache after the commit, so the change
  lands on their next request rather than their next login, and writes one audit row per
  field that actually changed. `PATCH /api/v1/teams/{id}` is additive to TAR-39's published
  surface: without it a supervisor could create a team and never change who is in it.
  (TAR-81)
- **Agent, team and role management console** — `/settings/people` invites agents with a
  role and teams, edits a role, status or membership, removes an agent, and creates and
  edits teams; `/settings/assignment` gives a supervisor tenant-wide agent and team
  workload; `/inbox` caps an agent's scope at their own and their teams' conversations and
  offers them no wider tab and no settings entry. Every permission decision asks whether the
  principal holds a permission, never whether they are an admin, reading `ROLE_PERMISSIONS`
  from `packages/contracts`. The gating is UX only — each server action asserts the
  permission again and the API asserts it a third time. Landed with the frontend foundation
  it needed: the three design-token layers, CSS Modules, the layout and UI primitives, the
  app shell, a typed route map and a typed env module. (TAR-82)
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
- **People and teams API reference** — `docs/reference/people-api.md`, covering the users
  and teams routes, the permission each needs, the four invariants, what a team does to
  visibility, the session revocation and audit rows a change writes, and the four
  cross-tenant attempts and their answers. The README gains a tenant-admin section on
  managing agents, teams and roles. Every request, response and refusal on the page was
  executed against a local stack, including with `AUTH_STUB_ENABLED=false` — session-based
  role enforcement is confirmed live rather than pending, and the interim role stub is
  documented as the development-only path it now is. (TAR-85)

### Changed

- **`assignment_rules` can hold a routing rule.** TAR-47 shipped the table with
  `conditions JSONB`, `position`, `is_active` and both target foreign keys under a comment
  saying TAR-24 owned the grammar; 0007 worked out what that grammar needed, and this is the
  four changes plus the one that turned out to be unnecessary. `name` is `citext` with
  `UNIQUE (tenant_id, name)`, on `teams.name`'s reasoning applied to a second name column —
  the rule name is what an audit reader sees in the ticket event recording why a ticket was
  routed, and `Billing` beside `billing` is two rules nobody can tell apart. An **active**
  rule must have exactly one target, enforced by
  `assignment_rules_active_has_one_target`; the condition on `is_active` is load-bearing
  rather than defensive, because `UsersService` deliberately leaves a target-less inactive
  rule behind when a rule's target user is removed, so that a supervisor finds a rule
  needing a new target instead of finding it gone. The ordering index becomes
  `(tenant_id, is_active, position, id)`, since `position` defaults to `0` and is not
  unique — without the `id` tie-break two rules created normally have no defined evaluation
  order at all. And `action JSONB` is **dropped**: the target is the two foreign-key
  columns, nothing read the column in `apps/api`, `apps/web` or `packages/contracts`, and
  two representations of one fact is a drift surface with no owner. A non-assignment rule
  action belongs to TAR-27's automation engine, which owns trigger/condition/action
  properly. Row-level security needed nothing — the table has had row-level security
  enabled, forced, and carrying its `tenant_isolation` policy since the initial migration,
  so no `pnpm db:roles` re-run follows this one. ⚠️ The `action` drop is the one destructive
  statement: `down.sql` restores the column and cannot restore its contents, which is
  acceptable only because it is unread and unwritten in every environment the migration can
  reach. Two of the constraints are invisible to Prisma — it can express neither a CHECK nor
  the fact that `citext` is what makes the unique index case-insensitive — so
  `src/prisma/assignment-rule-schema.int-spec.ts` asserts both against a real PostgreSQL,
  the same arrangement `tickets_one_active_per_contact` uses. (TAR-285)
- **Team membership is bounded, and a membership change costs the same whatever the team
  size.** `memberUserIds` and `teamIds` carried no upper bound, so a caller holding
  `team:write` could `POST /api/v1/teams` with ten thousand ids: validation passed, ten
  thousand rows were written, and the service then revoked one user's sessions per round
  trip — sequentially, inside the transaction, holding one pooled connection — before
  repeating the shape as one Redis call per user after the commit. A privileged caller
  rather than an anonymous one, but a self-inflicted availability cliff on a pool the whole
  tenant shares. Both arrays now cap at `TEAM_MEMBERSHIP_LIMITS` (500 members per team, 50
  teams per person), and the fan-out behind them collapses to one `UPDATE` over every
  affected user, one `INSERT` for their audit rows, and one pipelined pass over Redis with
  chunked deletes. Nobody loses a revocation: everybody affected is still logged out and
  still purged on both sides of the commit. A team can still pass the published ceiling one
  person at a time through `PATCH /users/{id}`, which bounds the other side of the relation
  — making it a database invariant needs a capacity check on every path that writes
  `team_members`, including invite acceptance, and that is its own change. (TAR-244)
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
- **The flagged-ticket queue is ordered oldest-stuck first, and can be narrowed to one reason**
  (TAR-365) — `GET /tickets?routingState=deferred` paged in the ticket queue's own
  `priority DESC, createdAt DESC, id DESC`, because TAR-273 shipped it as a predicate on that
  one list. ADR 0008 had said otherwise for a reason: `routing_deferred_since` earned a column
  of its own because it is "what the supervisor list sorts by (oldest stuck first)", and
  `tickets_routing_deferred_idx` was built to serve exactly that. The document won — this is a
  triage list of customers nobody has answered, where a ticket stuck since yesterday morning
  outranks an urgent one flagged a minute ago, and the console's "showing the N longest-waiting"
  line was a claim nothing upheld. A request pinned to the deferred set now pages
  `routing_deferred_since ASC, id ASC`; `id` is added to the ordering the ADR specified because
  one column is not a total order and a keyset page boundary inside a shared millisecond drops
  a row silently. **`deferredReason` is implemented** in the same change: the parameter has been
  published since TAR-274 and was accepted and dropped, so the supervisor's reason pills failed
  closed on every click — it is now an equality in the query rather than a filter over a fetched
  page, which is the difference between "no tickets for that reason" and the truth whenever the
  matching ones sort past the first page. **Still not a `sort` parameter**: the shape follows
  from the set asked for — `routingState=deferred`, or any `deferredReason`, which
  `tickets_routing_deferred_consistent` makes equivalent — so there is no third combination and
  no index to add. The two orders' cursors differ in **arity**, one sort value against two, so
  replaying one against the other answers `validation_failed` rather than paging from the wrong
  place; a cursor in flight across the deploy is refused rather than mis-paged. The flagged page
  emits a real `nextCursor`, because answering `null` on a set that is "small by definition"
  would report the first page as the whole queue for exactly the tenant this view exists for.
  No migration — the column, the index and the CHECK all shipped with TAR-272 — and the partial
  index supplies the predicate and the leading sort key, leaving the `id` tie-break as an
  incremental sort inside one millisecond. Recorded as ADR 0008 amendment 3.

### Fixed

- **Detaching a tenant's primary custom domain no longer leaves invite and password-reset
  links pointing at it** (TAR-534) — `AdminDomainsService.deactivate()` cleared
  `activated_at` and left `is_primary` exactly where it was, so the state TAR-420 blocks on
  _promotion_ — primary on a hostname the edge is not serving — was still reachable from the
  operator side. An operator detaching a domain during a certificate failure or a migration
  left every invite and reset mail addressed to a host with no route and no certificate, and
  nothing failed visibly: the mail sends, and the tenant finds out when a customer cannot get
  back into their account.
  Deactivation now hands primary back to the platform subdomain in the same transaction,
  mirroring what `remove()` already did, and names the new host on the deactivation audit row
  so the trail explains why a tenant's links changed. The two writes are ordered — the old
  primary is cleared by the same statement that clears `activated_at`, before the fallback is
  set — because `tenant_domains_one_primary` is a unique index and would otherwise reject the
  pair. A tenant with no platform subdomain to fall back to is left without a primary and
  logged rather than refused: the hostname is gone from the edge either way, and that tenant
  is a provisioning fault this path did not cause.
  `TenantLinkService.primaryHostname()` gained the matching filter as a net under it — a
  verified custom domain with no `activated_at` is now skipped in favour of the platform
  subdomain, so any future path that clears the column cannot re-open this. The realtime
  near-copy in `TenantHostnameService` skips it too, for the same reason and to keep the two
  queries from disagreeing about the same rows. Nothing here changes which hosts _resolve_:
  `HostTenantGuard` reads `verified_at`, and it is untouched.

- **A ticket answered in time is no longer breached because a queue job did not survive Redis**
  (TAR-380) — the breach sweep claimed timers with `WHERE state = 'running'`, which reads as
  "not yet answered" only if something reliably moves an answered timer out of `running`. The
  only thing that did was the `sla.evaluate-ticket` job, and `QueueService.enqueue` is
  contractually allowed to report `failed` or `unavailable` and drop it — a two-second
  `PRODUCER_COMMAND_TIMEOUT_MS` breach was enough. An agent replied at minute 40 of a 60-minute
  window, the `agent_replied` enqueue was lost, and the next sweep flipped the timer to
  `breached`, wrote the `sla_breached` event and alerted a supervisor about a ticket answered
  twenty minutes early. Because `breached` is terminal and outside `MUTABLE_STATES`, a later
  evaluation stamped `first_response_at` but **could not undo the state** — a permanent false
  breach, and the exact inverse of TAR-26's second acceptance criterion. It also contradicted
  ADR 0006's own failure table, which promised "Redis down — nothing is lost".
  The sweep now re-derives every due ticket through `SlaTimerService.reconcile` **inside the
  transaction it claims in**, so the claim reads state this sweep just established rather than
  state a job was trusted to have written. The obvious patch —
  `AND NOT EXISTS (… first_response_at IS NOT NULL)` — was rejected because it does not work:
  that column's only writer is the same dropped job, so it is null in precisely the failing
  case. Re-deriving also fixes the whole class rather than the first-response case; a dropped
  `status_changed` on a resolved ticket and a dropped pause were the same bug.
  It **settles** those timers as `met` rather than skipping them, which is not a detail: an
  unclaimed timer only gets older, so a declined one would lead its tenant's slice of every
  subsequent batch for ever and starve that tenant's real breaches. Cost, stated: three reads
  per due ticket, taking no lock when the ticket really is overdue — a full 200-timer
  single-tenant batch measured 1047 ms before and 1594 ms after. `ORDER BY ticket_id` on the
  re-derivation is load-bearing, not cosmetic: `DISTINCT` guarantees no ordering, and two
  sweeps meeting the same tickets in opposite orders would deadlock.
  ⚠️ Timers already sitting at a false `breached` are left alone. `breached` is terminal by
  design and unwinding one is a data decision rather than a code one. Recorded as ADR 0006
  amendment 2.

- **One stuck tenant no longer starves breach detection for every other tenant** (TAR-381) —
  the predicate that makes catch-up free, `due_at <= now()` ordered oldest-first, is also what
  makes a stuck tenant contagious: an unclaimed timer only gets _older_, so it sorts to the
  head of the next batch and of every batch after it. The global `ORDER BY due_at LIMIT 200`
  therefore handed the entire batch to one tenant's backlog for as long as that backlog
  existed. ADR 0006 had already closed one instance of this — a deactivated tenant, whose
  timers phase 2 can never claim, is excluded by joining `tenants.status` — and nothing guarded
  the general case: an **active** tenant whose phase 2 keeps failing, or simply one recovering
  from an outage with 200 due timers. `claimAndAlert` issued roughly four sequential round
  trips per timer inside one transaction, so a full batch was ~800 statements against a
  20-second timeout; it overran, rolled back **entirely**, and the identical 200 rows led the
  next sweep into the identical timeout. Platform-wide detection stopped, and the only symptom
  was one `SLA sweep failed for tenant …` line per tick — a warning that reads like one
  tenant's problem.
  Two bounds close it and neither is redundant. Phase 1 became a per-tenant `LATERAL` probe
  capped at `SLA_SWEEP_TENANT_BATCH` (50), so **at least four tenants are served by every
  sweep** whatever any one of them is doing — the half that survives a tenant failing
  permanently, which no amount of chunking helps. Phase 2 commits in chunks of
  `SLA_SWEEP_TENANT_CHUNK` (25), so partial progress survives and a tenant that overruns keeps
  what already landed — the half that stops a full rollback discarding successful work.
  `SLA_SWEEP_TENANT_TIMEOUT_MS` was renamed `SLA_SWEEP_CHUNK_TIMEOUT_MS` to match what it now
  bounds; the value is unchanged.
  The cost is drain rate for a single large tenant: 50 timers per sweep rather than 200, so a
  10 000-timer backlog takes ~100 minutes instead of ~25. Against a batch that previously
  committed _nothing_, that is a trade worth making. The access path changes with it — one
  bounded index probe per active tenant, against a `tenants` table that is small by definition,
  rather than one range scan. Also in this change: the sweep log line now carries `in Xms`,
  which ADR 0006 named as TAR-280's deliverable and which had been left out; a sweep drifting
  towards the 30-second interval is now visible before it becomes an overlap. Recorded as ADR
  0006 amendment 1.

- **A routing rule on "this field is not set" now fires for a brand-new customer** (TAR-370) —
  the engine resolved a contact's custom fields to `null` both when the ticket had no contact
  and when the contact existed with `custom_fields IS NULL`, and every operator is false against
  a null fact. `contacts.custom_fields` is nullable and a contact auto-created from a first
  inbound WhatsApp message leaves it null, so "`plan_tier` is not set → Onboarding team" never
  matched the exact population it targets — while looking correct in any test written against a
  contact somebody had edited once, because an edit writes `{}` or a populated object. A contact
  that exists now resolves to `{}` and a null fact means only "there is no contact to read", so
  `is_not_set` is true of a new contact and still false on a contact-less ticket. Corrupt
  `custom_fields` that do not parse stay unreadable rather than being reported as empty.
- **A routing rule can no longer be saved against a tag this tenant does not have** (TAR-370) —
  rule writes validated the target team, the target user and every `contact_attribute` key
  against `custom_field_defs`, but not the ids a `tag` condition names. Nothing leaked — the
  engine's `contact_tags` read is tenant-scoped, so a foreign id simply matches nothing — but a
  supervisor saving any other edit on a rule that referenced a since-deleted tag resubmitted the
  dead id, the API accepted it, and the rule silently never fired again with no error anywhere.
  `POST` and `PATCH` now answer `validation_failed` on `conditions.tagIds`, which is what the
  console's fixtures already did, so the two halves agree. ADR 0007's request table updated.
- **The supervisor's stuck-ticket queue is no longer permanently empty** (TAR-373) —
  `tickets.routing_state` shipped with TAR-272, was published by TAR-273 and was filtered on
  by TAR-274, and nothing in the API ever wrote it: ADR 0008 allocated the write to
  "whichever of TAR-273 and TAR-288 lands the router first", and TAR-288 landed the router
  without it. Every ticket therefore sat at the migration default `pending` for life, so
  `?routingState=deferred` returned an empty page and the supervisor view rendered "nothing
  is stuck" over tickets that were. TAR-23's second acceptance criterion — an unplaceable
  ticket "stays unassigned and is **flagged for supervisor attention**" — was met in its
  first half only, and the second half is what this restores. `RuleEngineService` now writes
  the column in the branch that decided it: `assigned` with both deferred fields cleared
  when a rule or rotation places the ticket, `deferred` with the rotation's reason and the
  moment it got stuck when nobody could take it. Both writes ride in the `UPDATE` that
  branch already issued rather than a second statement, because
  `tickets_routing_deferred_consistent` ties the state to its two nullable companions in
  both directions and would reject the row in between — which is also why assigning clears
  the pair instead of leaving a stale "all at capacity" on a ticket that is fine. The
  deferral is **first-transition-only** (`WHERE routing_state <> 'deferred'`, ADR 0008's
  one obligation on the router): `routing_deferred_since` is the ageing key the supervisor's
  list sorts on and it is not recoverable once overwritten, so a redelivered job appends its
  `assignment_deferred` event — the log is a history — and moves no column. A `skipped`
  outcome, including a supervisor winning the compare-and-set race, writes nothing at all,
  so `manual` stays terminal for routing. No migration: the columns, enums, index and CHECK
  all shipped with TAR-272.
- **The ticket-ensure job id no longer depends on an undocumented BullMQ exemption**
  (TAR-249) — `ticketEnsureJobId` published `ticket.ensure-for-message:<tenant>:<message>`,
  the one colon-bearing job id in the repo. BullMQ reserves `:` for its own Redis key
  structure and rejects a custom id containing one, with a single backwards-compatibility
  exemption for ids that split into exactly three parts — which is the only reason that
  shape ever worked, and BullMQ's own source marks the exemption `TODO` for removal. The
  failure it was one upgrade away from is a quiet one: `QueueService.enqueue` reports an
  outcome rather than throwing, so a rejected id would have logged one warning per inbound
  message and stopped creating tickets with nothing erroring. The id is now
  `ticket-ensure-<tenantId>-<messageId>`, hyphenated like `media-download-` and
  `webhook-event-` before it. It keeps `tenantId` even though `messageId` alone is unique,
  because that substring is the handle for filtering one tenant's ensure-jobs in a queue
  dashboard — exactly the triage being done when this class of thing goes wrong. The job
  _name_ `ticket.ensure-for-message` is unchanged: BullMQ restricts ids, not names. No
  migration and no queue drain — BullMQ routes by name and treats the id as opaque, so jobs
  already queued under the old id finish normally; during a rolling deploy a Meta retry of
  one message can produce a job under each shape, and both are `ensureTicketForMessage`
  calls, which is idempotent by contract. Recorded in ADR 0003 as implementation rule 5.
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
- **A reason pill on the supervisor's flagged-ticket queue no longer breaks the section**
  (TAR-365) — `deferredReason` was published by TAR-274 and never implemented, and an
  unimplemented query parameter is dropped rather than refused, so the API answered with a
  valid page of the wrong set. The console's `assertRoutingFilterHonoured` caught that and
  failed the section closed into its error boundary, which was the guard working as designed
  and a visibly broken control either way. The predicate ships in the Changed entry above; the
  guard stays, because a filter that stops being honoured — a rollback, an older API behind a
  newer console — is worth an error boundary rather than a contradiction rendered calmly.

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
