# Tenant lifecycle reference

What a tenant's lifecycle exposes to a caller: how it starts, what it is entitled to, where those
entitlements are enforced, what the trail records, and which endpoints exist. Written for
engineers. This is TAR-36's surface, designed by
[ADR 0009](../architecture/0009-tenant-lifecycle-and-self-signup.md).

Read three pages alongside it:

| For                                                   | Read                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| The states, every edge, and what is built             | [0012 — lifecycle state machine](../architecture/0012-tenant-lifecycle-state-machine.md) |
| How a visitor reaches a tenant                        | [Signup API reference](signup-api.md)                                                    |
| What the database refuses, and which client to inject | [Tenant isolation contract](tenancy.md)                                                  |

> **A large part of this surface is published and not implemented.** The contract package, the
> schema and the console all carry the full lifecycle; the engine that drives it does not exist
> on `main`. Every section below marks which is which, and
> [What is not built](../architecture/0012-tenant-lifecycle-state-machine.md#what-is-not-built-in-one-list)
> is the single list. Nothing here describes an endpoint as available unless it is.

## Provisioning: two paths, two starting states

`TenantProvisioningService.provision()` is the only writer of a new tenant row, on both paths.
The path is a discriminator rather than a `status` the caller picks, because the two differ on
three things at once — status, plan key and whether the trial clock is stamped — and letting a
caller choose them independently is how a tenant ends up `trialing` with no trial end, or
`active` on trial caps.

| Path          | Entered by                   | Status     | `trial_ends_at`                              | `tenant_entitlements`            |
| ------------- | ---------------------------- | ---------- | -------------------------------------------- | -------------------------------- |
| `operator`    | `POST /api/v1/admin/tenants` | `active`   | `null`                                       | `unlimited` — every limit `null` |
| `self_signup` | `POST /api/v1/signup/verify` | `trialing` | now + `LIFECYCLE_POLICY.trialDays` (14 days) | `trial` — the column default     |

An operator-provisioned tenant gets `unlimited` rather than the trial's caps deliberately: a
tenant nobody sold a plan to must not inherit ceilings nobody agreed to. That is the same
judgement TAR-403's migration made when it grandfathered every tenant existing at the time as
`unlimited`.

Provisioning is idempotent on `slug` and completes inside one transaction, which is why no tenant
is ever observable in `created` — the column's default and the fail-closed state of a row written
by anything that is not this service.

`POST /api/v1/admin/tenants` is documented in [the platform admin API reference](admin-api.md).

## Entitlements

One row per tenant in `tenant_entitlements`: `plan_key`, `plan_name`, and `entitlements` as
`PlanEntitlementsSchema` — `{ features: PlanFeature[], limits: { … } }`. It is RLS-scoped, and it
is the **only** thing both write-time enforcement and the console read, so a refusal an admin
just received and the "3 of 3" on their screen cannot come from different stores.

The row is a **snapshot** of a catalogue rather than a pointer into one: a tenant keeps what it
was sold when the catalogue moves under it. `plans` stays the platform catalogue and belongs to
TAR-37; when that lands, its plan sync becomes this table's writer. Swapping the trial placeholder
for real plan data is an update to these rows — not a code change and not an API change.

### The trial plan

The column default, and what a self-signup tenant starts on:

```json
{
  "features": ["assignment_rules", "sla_policies"],
  "limits": {
    "seats": 3,
    "conversationsPerPeriod": 1000,
    "whatsappNumbers": 1,
    "teams": 2,
    "knowledgeDocuments": 10
  }
}
```

**`null` is unlimited**, deliberately not `-1` or a sentinel maximum — both invite arithmetic
bugs at the comparison site. `tenant_entitlements_shape` is the database backstop: it asserts the
five limit keys are present and each is null or a positive integer, and that `features` is an
array. It cannot check feature _values_, so `PlanEntitlementsSchema` at every write site is the
actual contract.

### Where each limit is enforced

"Enforced, not merely displayed" is TAR-36's second acceptance criterion. Two of the five limits
have a write path that refuses today.

| Limit                    | Refused at                                        | Code                  | Built               |
| ------------------------ | ------------------------------------------------- | --------------------- | ------------------- |
| `seats`                  | `POST /users/invites` **and** invite acceptance   | `plan_limit_exceeded` | Yes                 |
| `conversationsPerPeriod` | The outbound send, once the counter is at the cap | `plan_limit_exceeded` | Yes                 |
| `whatsappNumbers`        | WABA connect                                      | `plan_limit_exceeded` | No                  |
| `teams`                  | Team create                                       | `plan_limit_exceeded` | No                  |
| `knowledgeDocuments`     | Document create                                   | `plan_limit_exceeded` | No                  |
| `features`               | `@RequireFeature`, pipeline stage 6               | `feature_not_in_plan` | No — TAR-37's guard |

`plan_limit_exceeded` carries the limit name, the cap and the current usage, so a caller can
render "3 of 3 seats in use" without a second request. There is one error code for all five
limits, not one per quota: the limit travels as a field, so adding a limit is not a contract
change.

**Seats are checked at both creation and acceptance, deliberately.** Creation is where the admin
finds out; acceptance is the guarantee. Enforcing only creation lets two simultaneous acceptances
overshoot the cap; enforcing only acceptance surprises the admin a week later.

A seat is held by a member whose status is `active` **or `suspended`**, plus every live pending
invite (`accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`). Both halves matter:

- Counting only accepted members would let an admin mint unlimited pending invites and blow past
  the cap the moment a mailout lands.
- Releasing a suspended member's seat would let a tenant park staff to dodge the cap. This is
  already what `UserResponse.occupiesSeat` has published since TAR-166, and the enforcement is
  what makes it mean something.

Re-sending a link to an address that already holds a live invitation skips the check — the seat
was taken when it was first sent and is still counted, so refusing would mean an admin at 3 of 3
could not refresh a link about to expire.

The seat check takes a transaction-scoped advisory lock keyed by tenant, because it is
read-then-write and two invitations landing together would both read "2 of 3" and both insert.
The conversation check takes **no** lock: volume is a monotonic counter against a ceiling that
gates and warns and never bills, so an overshoot of a handful under concurrency costs nothing,
and serialising every tenant's sends on one lock is the wrong trade on the busiest path in the
product.

### The conversation cap is never applied to inbound

A conversation is opened by a customer writing in, so `usage_counters.conversations_opened` is
incremented by the inbound writer. The cap is checked at the **outbound send**. Dropping an
inbound message to enforce a quota would lose a real person's message to fix a billing problem;
what a spent allowance withholds is the tenant's ability to reply.

The period is `[start, end)`, resolved in exactly one place (`UsagePeriodResolver`):

1. A `subscriptions` row with both `current_period_start` and `current_period_end` set — the
   provider's own billing period.
2. Otherwise the **anniversary-monthly** window on `tenants.created_at`.

`created_at` and not `trial_ends_at`, because the anchor has to be immutable: the lifecycle
clears every forward-looking column on the transition that leaves the state which set it, so
`trialing → active` nulls `trial_ends_at`, and `period_start` is part of
`@@unique([tenant_id, metric, period_start])`. Moving it would fork a second row and hand the
tenant a fresh allowance mid-period. The window is always recomputed from the anchor rather than
by advancing the previous period, which drifts across month ends and never recovers.

### A missing row means unlimited

A tenant with no `tenant_entitlements` row is uncapped, and that is a decision. The cap is a
billing ceiling, not a security boundary — tenant isolation is row-level security's job and is
unaffected either way — so open is the correct failure direction. Failing closed would make the
invite route start refusing for tenants nobody ever capped.

Provisioning writes the row on both paths precisely so that fallback stays unreachable in
practice. It is a backstop for rows written before that change.

> ⚠️ **The trial's caps are enforced before anything can be bought.** A tenant that hits the
> three-seat cap during its trial has no route to a larger plan until TAR-37 ships, and the
> `plan_limit_exceeded` message names a support contact rather than a checkout page. This is a
> known temporary state (0009, risk 4).

## The lifecycle trail

`lifecycle_events` — every transition, append-only, and the audit trail TAR-36's sixth acceptance
criterion asks for.

**It is platform-level, not tenant-scoped**, and that is the whole design: no foreign keys, no
`tenant_isolation` policy, `system-only` under `TenantPrisma`. Three consequences:

1. **It survives the purge**, because nothing cascades into it. `tenant_id` and `actor_user_id`
   are recorded identifiers that outlive the rows they name.
2. **It is readable after the tenant is no longer serviceable.** A row under `tenant_isolation`
   needs the `app.tenant_id` GUC, and setting that GUC runs the database gate, which refuses
   `deleted`. An audit trail you cannot read once the thing it describes has been shut off is not
   an audit trail.
3. **The purge can finish.** A composite foreign key to `users` made it impossible: the purge
   deletes every `users` row and keeps the `tenants` row as the slug tombstone, so a retained
   event carrying `actor_user_id` blocked the delete with SQLSTATE 23503 — and could not be
   repaired on the way past, because the append-only trigger refuses the UPDATE and neither
   application role holds DELETE.

Append-only is enforced twice: `prisma/sql/app-roles.sql` grants `SELECT, INSERT` to
`whatsappcrm_system` alone, and the `lifecycle_events_append_only` trigger raises `TN002` on any
UPDATE including the table owner's. `notified_at` is the single exception — a one-way
null-to-value stamp, permitted by a **column-level** `GRANT UPDATE ("notified_at")` while
table-level UPDATE stays withheld.

Columns are in `apps/api/prisma/schema.prisma` (`model LifecycleEvent`). Two that decide how a
row reads:

- **`trigger`** (`user_action | operator_action | billing_event | timer | system`) says what kind
  of event caused the edge. **`actor_type`** says who. Both are recorded because either alone is
  ambiguous: an operator can hand-post a billing event, and a timer fires with `system` as its
  actor and nobody behind it. `trigger` is what makes "no `active → past_due` from a button"
  assertable rather than aspirational.
- **`reason`** is free text written by whoever caused the transition, and is **never rendered to
  a tenant** — it is where an operator writes "fraud, card chargeback". The operator read
  endpoint returns it; the tenant-facing one does not. `metadata` is the same: a provider event
  id or an elapsed-timer measurement, platform forensics rather than something a tenant admin
  needs. Neither is in `TenantLifecycleEventSchema`.

> **Nothing writes this table today.** Its only rows are the ones TAR-403's migration backfilled
> for the state each tenant was already in, carrying `actor_type = 'unattributed'` and
> `trigger = 'system'`. Application code never writes `unattributed`.

## Endpoints

### Available

| Route                                          | Auth                   | Notes                                 |
| ---------------------------------------------- | ---------------------- | ------------------------------------- |
| `POST /api/v1/signup`                          | none                   | [Signup API reference](signup-api.md) |
| `POST /api/v1/signup/verify`                   | the emailed token      | Provisions a `trialing` tenant        |
| `POST /api/v1/signup/resend`                   | none                   |                                       |
| `GET /api/v1/signup/slug-available`            | none                   |                                       |
| `POST /api/v1/admin/tenants`                   | `PLATFORM_ADMIN_TOKEN` | [Admin API reference](admin-api.md)   |
| `POST /api/v1/admin/tenants/{slug}/deactivate` | `PLATFORM_ADMIN_TOKEN` | Writes `suspended` — see below        |

**`deactivate` keeps its name** rather than becoming `suspend`. [The style
guide](../STYLE.md#terminology) fixes _deactivate_ as the operator's verb for this operation; the
lifecycle _state_ is `suspended` and the _operation_ is `deactivate`.

What deactivation writes today, and what it does not: it sets `tenants.status = 'suspended'` and
`tenants.suspended_at`, and writes one `audit_logs` row in the same transaction. It writes no
`lifecycle_events` row, sets no `purge_at`, and sends no email. It refuses a tenant already
`suspended`, `cancelled` or `deleted`, and it does not reactivate — 0009 puts the inverse in the
lifecycle engine so that an endpoint which exists to take access away is not also the one that
gives it back.

### Published, not implemented

Every route below has a published request and response shape in `packages/contracts` and returns
`404` on `main`. They are TAR-404's, and TAR-404's merged pull request delivered the contract
vocabulary rather than the engine.

```text
# Tenant admin — session, tenant host
GET    /api/v1/tenant/lifecycle          → TenantLifecycleResponse           tenant:settings
GET    /api/v1/tenant/lifecycle/events   → CursorPage<TenantLifecycleEvent>  tenant:settings
POST   /api/v1/tenant/cancel             → TenantLifecycleResponse           billing:manage
POST   /api/v1/tenant/cancel/undo        → TenantLifecycleResponse           billing:manage
POST   /api/v1/tenant/delete             → TenantLifecycleResponse           billing:manage

# Tenant admin — the onboarding checklist (contract published by TAR-407)
GET    /api/v1/tenant/onboarding                  → OnboardingChecklistResponse  tenant:settings
PATCH  /api/v1/tenant/onboarding/steps/{stepId}   → OnboardingChecklistResponse  tenant:settings

# Platform operator — PLATFORM_ADMIN_TOKEN
POST   /api/v1/admin/tenants/{slug}/reactivate → AdminTenantLifecycleResponse
POST   /api/v1/admin/tenants/{slug}/cancel     → AdminTenantLifecycleResponse
POST   /api/v1/admin/tenants/{slug}/delete     → AdminTenantLifecycleResponse
GET    /api/v1/admin/tenants/{slug}/lifecycle  → CursorPage<TenantLifecycleEvent>
```

No new permissions: `tenant:settings` gates the lifecycle reads and `billing:manage` gates
cancel, undo and delete. Both are admin-only in `ROLE_PERMISSIONS` today. Deleting a tenant on
`billing:manage` rather than a new `tenant:delete` is a deliberate narrowing — the people who can
end a tenant's life are the ones who can end its subscription, and a permission exactly one role
holds adds a row to the matrix and no safety.

Two shapes worth knowing before they land:

- **`POST /tenant/delete` schedules; it does not delete.** It transitions to `cancelled` with a
  grace period, which reaches `suspended` and then `purge_at`. An endpoint that destroyed data
  synchronously would have no retention window, and TAR-36's criterion is "when the retention
  window elapses". `TenantDeleteInput.confirmSlug` must equal the tenant's own slug, checked
  server-side.
- **`TenantLifecycleResponse` is not `BillingSummaryResponse`.** That one is TAR-37's and
  describes a subscription; this describes a lifecycle, and the two coexist — a tenant with no
  subscription still has one of these. It carries `status`, the three timer instants, `plan`
  (key, name, entitlements) and `usage` (`seatsUsed`, `seatsPending`, `conversationsThisPeriod`).
  `seatsUsed` and `seatsPending` are separate fields because the console shows the sum against
  the cap and names the two parts: "4 of 5, one invitation outstanding" is legible where
  arithmetic the reader has to do is not.

### The console reads a mock today

`/onboarding` and `/settings/workspace` render `OnboardingChecklistResponse` and
`TenantLifecycleResponse` against the mock transport in `apps/web/lib/api/mock/handlers.ts`,
selected by `NEXT_PUBLIC_USE_MOCK_API`. That is what TAR-407 and TAR-409 were scoped to do —
build against the published contract without waiting for the backend — and the resource modules
in `apps/web/lib/api/` are byte-identical in both modes, so wiring the real endpoints is a
configuration change rather than a component one.

Pointed at the real API with the flag off, both screens fail: the routes they call do not exist.

## Errors

| Code                    | Status | Raised when                                                                    |
| ----------------------- | ------ | ------------------------------------------------------------------------------ |
| `plan_limit_exceeded`   | 402    | A seat or conversation cap has no room for the write. Carries limit, cap, used |
| `subscription_inactive` | 402    | The tenant in scope is not serviceable — anywhere, not only at login           |
| `conflict`              | 409    | A slug is taken, at provisioning or at signup                                  |
| `not_found`             | 404    | An operator named a slug no tenant carries; or signup is disabled              |

`subscription_inactive` is the single published answer for `TenantNotActiveError`, wherever it is
raised (TAR-539). Ten per-domain translators throw `tenantInactive()` from
`apps/api/src/common/errors/tenant-inactive.ts`, and `AllExceptionsFilter` answers the same thing
for anything that reaches HTTP without a translator — a guard, an interceptor, a tenant suspended
mid-request. So a member of a `suspended`, `cancelled`, `created` or `deleted` tenant gets `402`
and one fixed message on every tenant-scoped route, not just at login.

**Never put the error's own message in a response body.** It is written for an engineer reading a
log and names `TenantPrisma`, the failing model and the tenant's UUID; the caller who would see it
is by definition one who has just been locked out. `tenantInactive()` is the helper that gets this
right, and the filter logs the thrown error under the same `requestId` the caller was shown.

When `TenantStatusGuard` lands (TAR-538) it answers the same code at pipeline stage 4, for every
route outside the recovery allowlist. That is deliberate: the guard refuses at the edge, this
catches whatever reached the data layer first, and both say the same thing. See
[the tenant isolation contract](tenancy.md#errors).

## Open questions this page inherits

Both are 0009's and neither has been answered in the repository.

1. **`purgeAfterSuspendedDays = 30`** is a policy decision, recorded in TAR-18 as "pending client
   policy". It is the only lifecycle number that is irreversible in the wrong direction. Changing
   it later is safe in both directions, because the sweep reads the constant on every pass rather
   than baking a date into a row at suspension time.
2. **"Agents cannot log in while suspended"** is TAR-36's fourth acceptance criterion, and 0009
   records the architect's disagreement with it: a suspended tenant whose agents can read the
   history but not send loses nothing a reseller cares about, and is what
   `outboundAllowed: false` already described. The design ships to the criterion; changing it is
   one row of `TENANT_STATUS_EFFECTS` and one test.
