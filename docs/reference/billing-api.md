# Billing API reference

The five tenant routes under `/api/v1/billing`, the provider webhook receiver at
`/api/webhooks/billing`, and the machinery behind them: how a checkout becomes an active
subscription, how seats and conversation volume are metered and enforced, and how a failed
payment reaches suspension. Written for engineers building against the API or the console.

For the tenant admin who compares tiers and pays in the console rather than calling the API,
read [Choose a plan and manage billing](../guides/manage-your-plan-and-billing.md). For the
platform operator provisioning provider credentials, read
[Connecting the billing provider](../runbooks/billing-provider.md).

**The payment provider is behind a port, and this surface never names it.** Request and
response shapes live in `packages/contracts/src/billing.ts` and
`packages/contracts/src/usage.ts`; enforcement lives in `apps/api/src/billing/` and
`apps/api/src/entitlements/`. The only two files that know Polar exists are
`apps/api/src/billing/providers/polar/polar-billing.provider.ts` and
`apps/api/src/billing/providers/polar/polar-event.mapper.ts`. Nothing in `apps/web` names a
provider at all, and no provider identifier reaches a tenant-facing response.

> **TODO(author):** the source comments cite a _billing contract_ by decision number
> ("billing contract, decision 1", "decision 4", "decision 6", "contract open question 4").
> That document was delivered as an attachment on TAR-616, with an amendment on the same
> issue; neither is in this repository, so those citations resolve to nothing a reader can
> open. Every decision they name is restated below from the code, but the contract itself
> belongs under `docs/architecture/` — it is the only cross-cutting design in the product
> that did not land there.

## Conventions

| Concern           | Rule                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Base path         | `/api/v1` for the tenant routes; the webhook receiver is deliberately unversioned          |
| Tenant            | Resolved from the request `Host`, never from a body, header or query parameter             |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                            |
| Money             | `{ amountMinor, currency }` — an integer count of the currency's minor unit, never a float |
| Timestamps        | ISO 8601 with an explicit offset. Serialised as UTC, so always `Z`                         |
| Error shape       | The standard envelope, with a code from `packages/contracts/src/error-codes.ts`            |
| `Idempotency-Key` | **Required on `POST /billing/checkout`** and used nowhere else on this surface             |

**`POST /api/webhooks/billing` carries no `v1`.** The URI version prefix is a contract with
_our_ clients. That URL is registered once inside the provider's dashboard, and changing it
means an outage plus a manual reconfiguration, so it sits outside the versioning scheme —
the same posture `whatsapp-webhook.controller.ts` takes for Meta.

## Authentication and permissions

The five tenant routes require a signed-in user presenting the session cookie `wac_session`
— `__Host-wac_session` wherever `SESSION_COOKIE_SECURE` is on. The webhook receiver
authenticates with a signature over the raw body and nothing else; see
[The webhook pipeline](#the-webhook-pipeline).

| Route                              | Permission       | Held by |
| ---------------------------------- | ---------------- | ------- |
| `GET /api/v1/billing/plans`        | `billing:read`   | admin   |
| `GET /api/v1/billing/subscription` | `billing:read`   | admin   |
| `GET /api/v1/billing/usage`        | `billing:read`   | admin   |
| `POST /api/v1/billing/checkout`    | `billing:manage` | admin   |
| `POST /api/v1/billing/portal`      | `billing:manage` | admin   |

Both permissions are admin-only in `ROLE_PERMISSIONS`
([ADR 0004](../architecture/0004-rbac-permission-matrix.md)), and the split is the one that
matters: an admin who can see what the workspace is paying is not automatically one who can
change it. An agent or a supervisor gets `403 forbidden`, and the console renders a
read-only notice rather than a dead button.

### Every route works while the tenant is suspended

`TENANT_STATUS_EFFECTS.suspended` sets `apiAccess: false`, and all five routes carry
`@AvailableWhileSuspended()` as the deliberate exception: **a suspended tenant whose admin
cannot reach checkout cannot pay its way out.** The decorator's exemption is conditional on
holding `admin`, so what it admits is exactly the person who can fix the situation. A
`created` or `deleted` tenant is still refused by the database gate with `tenant_inactive`.

## The plan and the entitlements it grants

Two tables, and the difference between them is the whole model.

`plans` is the **catalogue**: platform-wide, one row per purchasable tier, no tenant column
and no row-level security. `tenant_entitlements` is the **enforcement truth**: one
RLS-scoped row per tenant holding a _snapshot_ of what that tenant was sold, so a tenant
keeps its allowances when the catalogue moves under it.

`SubscriptionSyncService` copies `plans.entitlements` onto `tenant_entitlements` inside the
transaction that writes the subscription, which is what makes "the plan's limits take effect
immediately" true. Every enforcement check reads the tenant's own row and never joins the
catalogue: a seat check on the request path must not depend on an unscoped table, and a
trialing tenant has no subscription row to join through.

A tier's entitlements are `PlanEntitlementsSchema` — `{ features, limits }`:

| Limit                    | Meaning                                 | Enforced at                               |
| ------------------------ | --------------------------------------- | ----------------------------------------- |
| `seats`                  | Billable agent seats                    | Invite creation **and** invite acceptance |
| `conversationsPerPeriod` | Conversations opened per billing period | The outbound send, and only under `block` |
| `whatsappNumbers`        | Connected WhatsApp Business Accounts    | Nothing yet                               |
| `teams`                  | Teams                                   | Nothing yet                               |
| `knowledgeDocuments`     | Knowledge documents                     | Nothing yet                               |

**`null` is unlimited**, deliberately not `-1` or a sentinel maximum, both of which invite
arithmetic bugs at the comparison site. A tenant with no `tenant_entitlements` row at all is
also unlimited — the cap is a billing ceiling rather than a security boundary, so open is
the correct failure direction. The full reasoning, and the trial defaults, are in the
[tenant lifecycle reference](tenant-lifecycle.md#entitlements).

> ⚠️ **`features` is published and not enforced.** `PLAN_FEATURES` names eight capability
> gates and every tier carries a set of them, but no `@RequireFeature` guard exists in
> `apps/api/src` — the identifier appears in one comment and nowhere else. A tenant on a tier
> without `ai_chatbot` can still call the chatbot routes. The array is an honest record of
> what a tier was _sold_; it is not a runtime check, and `feature_not_in_plan` is a published
> error code nothing currently throws.
>
> **TODO(author):** which story closes this? TAR-37's scope names "plan/tier model with seat
> and volume allowances and feature gating"; the seat and volume halves shipped and the third
> did not.

**Plan keys are the only thing plan logic branches on.** `PlanSchema.key` matches
`/^[a-z][a-z0-9_]*$/`, and `plans.provider_product_id` — the provider's opaque product
identifier — is read only by `CheckoutService` and passed straight through to the adapter.
It is in no response projection.

> ⚠️ **`plans.key` has no database constraint behind that pattern.** The column is `text`
> with a uniqueness index and no format check, so a hand-written row with a hyphen in its key
> is accepted by the database and then fails `PlanListResponseSchema.parse` in the console —
> which took the whole billing page down for every tenant until TAR-657. Seed plan keys
> through the seed, or match the pattern by hand.

### `PlanSchema.isPublic` reports `plans.is_active`

There is no `is_public` column. The two are not the same distinction — `is_active` is "may
still be subscribed to", `is_public` is "shown on the pricing page" — and the field reports
`is_active` because that is the closest true statement available. The practical effect is
identical today: every active plan is listed. Splitting them is a column and a migration, and
it belongs to whoever first needs a tier that is buyable but unlisted.

A withdrawn tier (`is_active = false`) is hidden from `GET /billing/plans` and still honoured
for the tenants already on it: `SubscriptionSyncService` resolves a plan **without** filtering
on `is_active`, so retiring a tier does not strip a paying customer's entitlements.

## `GET /api/v1/billing/plans`

Every purchasable tier, with this tenant's position in it.

**Authentication.** Session cookie, `billing:read`. Available while suspended.

**Idempotency.** Safe.

No parameters.

```bash
curl https://acme.app.example.com/api/v1/billing/plans \
  -b cookies.txt
```

```json
{
  "plans": [
    {
      "id": "019fed83-ebd1-774d-86e4-46137546a539",
      "key": "starter",
      "name": "Starter",
      "pricePerSeat": { "amountMinor": 2900, "currency": "USD" },
      "interval": "month",
      "entitlements": {
        "features": ["assignment_rules", "sla_policies", "channel_whatsapp"],
        "limits": {
          "seats": 3,
          "conversationsPerPeriod": 1000,
          "whatsappNumbers": 1,
          "teams": 2,
          "knowledgeDocuments": 10
        }
      },
      "isPublic": true,
      "isCurrent": false,
      "isSelectable": false,
      "blockedBy": ["seats"]
    },
    {
      "id": "019fed83-ebd1-774d-86e4-46137546a53a",
      "key": "growth",
      "name": "Growth",
      "pricePerSeat": { "amountMinor": 7900, "currency": "USD" },
      "interval": "month",
      "entitlements": {
        "features": [
          "assignment_rules",
          "sla_policies",
          "workflows",
          "advanced_reporting",
          "api_access",
          "channel_whatsapp"
        ],
        "limits": {
          "seats": 10,
          "conversationsPerPeriod": 10000,
          "whatsappNumbers": 3,
          "teams": 10,
          "knowledgeDocuments": 100
        }
      },
      "isPublic": true,
      "isCurrent": true,
      "isSelectable": true,
      "blockedBy": []
    }
  ],
  "usage": { "seatsUsed": 4, "seatsPending": 1, "conversationsThisPeriod": 320 }
}
```

| Status | Code              | Cause                            |
| ------ | ----------------- | -------------------------------- |
| `200`  | —                 |                                  |
| `401`  | `unauthenticated` | No session                       |
| `403`  | `forbidden`       | No `billing:read`                |
| `403`  | `tenant_inactive` | Tenant is `created` or `deleted` |

Plans are ordered by price ascending. `isCurrent` compares `tenant_entitlements.plan_key`,
not the subscription's plan, so a trialing tenant sees its trial tier marked current when the
catalogue carries one.

**`isSelectable` and `blockedBy` are computed server-side.** They depend on live usage the
client does not hold, and they exist so a downgrade that would leave a tenant over its own
new cap is refused _before_ payment rather than after it. `blockedBy` names only the two
ceilings an admin can act on from this page — a tenant over a plan's WhatsApp-number or team
ceiling is a real conflict too, and `PlanListResponse` deliberately offers no vocabulary for
it. The console disables the button; `CheckoutService` refuses the request again if the
button is bypassed.

The seat figure both booleans measure against is `seatsUsed + seatsPending`.

## `GET /api/v1/billing/subscription`

What the workspace is on, what it has used, and when it renews. The billing settings page
renders this response and one call to `GET /billing/plans`, and nothing else.

**Authentication.** Session cookie, `billing:read`. Available while suspended.

**Idempotency.** Safe.

```bash
curl https://acme.app.example.com/api/v1/billing/subscription \
  -b cookies.txt
```

```json
{
  "subscription": {
    "id": "019fee0a-1c33-7b58-9f21-8a7d0c4e1b62",
    "tenantId": "019fed83-ebd1-774d-86e4-46137546a539",
    "planKey": "growth",
    "status": "active",
    "seats": 5,
    "currentPeriodStart": "2026-08-01T00:00:00.000Z",
    "currentPeriodEnd": "2026-09-01T00:00:00.000Z",
    "cancelAtPeriodEnd": false,
    "trialEndsAt": null,
    "createdAt": "2026-07-01T09:14:22.481Z",
    "updatedAt": "2026-08-01T00:00:11.204Z"
  },
  "plan": {
    "id": "019fed83-ebd1-774d-86e4-46137546a53a",
    "key": "growth",
    "name": "Growth",
    "pricePerSeat": { "amountMinor": 7900, "currency": "USD" },
    "interval": "month",
    "entitlements": {
      "features": [
        "assignment_rules",
        "sla_policies",
        "workflows",
        "advanced_reporting",
        "api_access",
        "channel_whatsapp"
      ],
      "limits": {
        "seats": 10,
        "conversationsPerPeriod": 10000,
        "whatsappNumbers": 3,
        "teams": 10,
        "knowledgeDocuments": 100
      }
    },
    "isPublic": true
  },
  "entitlements": {
    "features": [
      "assignment_rules",
      "sla_policies",
      "workflows",
      "advanced_reporting",
      "api_access",
      "channel_whatsapp"
    ],
    "limits": {
      "seats": 10,
      "conversationsPerPeriod": 10000,
      "whatsappNumbers": 3,
      "teams": 10,
      "knowledgeDocuments": 100
    }
  },
  "usage": { "seatsUsed": 4, "seatsPending": 1, "conversationsThisPeriod": 320 },
  "cancelsAt": null
}
```

Error rows are identical to `GET /billing/plans`.

Four things about this shape are load-bearing.

**`subscription` is null for a workspace that has never bought anything**, which is the
normal state of a trialing tenant rather than a failure. It is _also_ null when a row exists
whose period bounds the provider has not set: `SubscriptionSchema` requires both, and
reporting no subscription is better than inventing dates. `plan` is still returned in that
case, so the console can say "you are on Growth" without a billing period it would have to
make up.

**`entitlements` is the enforced set, not the catalogue's.** They are normally the same — the
subscription writer copies one onto the other — and where they differ it is because an
operator hand-adjusted a tenant, and the number actually being enforced is the one to show.

**`trialEndsAt` is always `null`.** Trials live on `tenants.trial_ends_at`, which the
lifecycle owns and `GET /api/v1/tenant/lifecycle` reports. Restating it here would give the
console two clocks for one deadline.

**`cancelsAt` being non-null does not mean the tenant is cancelled.** It means a cancellation
has been _requested_: the tenant has paid through that date and stays fully serviceable until
it. The console renders a "closing on {date}" banner from it.

## `GET /api/v1/billing/usage`

The counters, each against the ceiling that applies to it.

**Authentication.** Session cookie, `billing:read`. Available while suspended.

**Idempotency.** Safe.

```bash
curl https://acme.app.example.com/api/v1/billing/usage \
  -b cookies.txt
```

```json
{
  "period": { "start": "2026-08-01T00:00:00.000Z", "end": "2026-09-01T00:00:00.000Z" },
  "counters": [
    { "metric": "seats_active", "value": 5, "limit": 10 },
    { "metric": "conversations_opened", "value": 320, "limit": 10000 }
  ]
}
```

Two metrics, not five. `USAGE_METRICS` also carries `messages_sent`, `messages_received` and
`ai_replies`, recorded from day one because they are real costs; none is metered against a
ceiling at v1, and listing them beside two that are would read as five limits.

`seats_active` is reported as `seatsUsed + seatsPending` read from the same function the
invite check enforces on — not from `usage_counters` — so the panel and the refusal cannot
disagree about how many seats are in use.

**The period is the subscription's own, never the calendar month.** `UsagePeriodResolver`
takes `subscriptions.current_period_start`/`_end` when both are set, and otherwise an
anniversary-monthly window anchored on `tenants.created_at`, which is what gives a trialing
tenant a period at all. A counter can therefore never straddle two invoices.

## `POST /api/v1/billing/checkout`

Opens a provider-hosted checkout session and returns the URL to send the browser to.

**Authentication.** Session cookie, `billing:manage`. Available while suspended.

**Idempotency.** **Required.** An `Idempotency-Key` header is mandatory and its absence is
`validation_failed` rather than a silently unprotected request: this is the one route in the
module that costs the customer money, and a client that forgot the header would be one
double-click from two subscriptions. The key is scoped to `planKey`, so retrying "upgrade me
to growth" is a replay, while the same key against a different plan answers
`idempotency_key_reused`.

| Parameter         | In     | Type   | Required | Default                                | Notes                                            |
| ----------------- | ------ | ------ | -------- | -------------------------------------- | ------------------------------------------------ |
| `Idempotency-Key` | header | string | yes      | —                                      | One per deliberate click                         |
| `planKey`         | body   | string | yes      | —                                      | 1–40 characters, `/^[a-z][a-z0-9_]*$/`           |
| `seats`           | body   | int    | no       | seats currently held                   | Raised to the held count; never written below it |
| `successPath`     | body   | string | no       | `/settings/billing?checkout=success`   | A **path**, must start with `/`, ≤512 characters |
| `cancelPath`      | body   | string | no       | `/settings/billing?checkout=cancelled` | Same rules                                       |

```bash
curl -X POST https://acme.app.example.com/api/v1/billing/checkout \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 019fee11-2b40-7c19-8d6a-3f8b71c40e55' \
  -b cookies.txt \
  -d '{"planKey":"growth","successPath":"/settings/billing?checkout=succeeded&planKey=growth"}'
```

```json
{
  "url": "https://checkout.example.com/c/019fee11-9a2f-7d31-b0c4-6e2d8a51f733",
  "expiresAt": "2026-08-22T11:30:00.000Z"
}
```

| Status | Code                     | Cause                                                                          |
| ------ | ------------------------ | ------------------------------------------------------------------------------ |
| `200`  | —                        |                                                                                |
| `400`  | `validation_failed`      | No `Idempotency-Key`, an absolute `successPath`, or a malformed body           |
| `401`  | `unauthenticated`        | No session                                                                     |
| `402`  | `plan_limit_exceeded`    | The chosen plan's ceilings sit below current usage                             |
| `403`  | `forbidden`              | No `billing:manage`                                                            |
| `404`  | `not_found`              | No active plan with that `planKey`                                             |
| `409`  | `conflict`               | The same key is still in flight                                                |
| `409`  | `idempotency_key_reused` | The same key against a different plan                                          |
| `502`  | `upstream_unavailable`   | Provider unreachable, plan not mapped to a provider product, or no return host |

**`successPath` and `cancelPath` are paths, not URLs, and that is a security control.** The
API composes them against the host the control plane holds for the tenant. A payment provider
redirects the browser to whatever URL it is handed, so an absolute URL from a client would be
an open redirect with a payment page in front of it — the one screen where a user is most
primed to trust where they land. `TenantLinkService` is the single resolver for that rule,
shared with the one that keeps a password-reset token from being aimed at an attacker's
server. A tenant with no deliverable domain has nowhere legitimate to return to, so checkout
is refused with `upstream_unavailable` rather than opened with a guess.

**A plan whose ceilings sit below live usage is refused here as well as marked
unselectable.** The console disabling a button is a courtesy; the API refusing the request is
the enforcement. `details` carries `{ "path": "seats", "message": "10 of 3 in use" }`, the
same envelope a refused invite produces, so the console has one renderer for "your plan is
full" whichever route produced it.

**Seats default to what is already held and never fall below it** — the value written is
`max(requested, seatsUsed + seatsPending, 1)`. Checking out for fewer seats than are in use
would create a subscription that is over its own cap the moment it activates.

**The response is navigated to, not rendered.** `HostedSessionSchema` constrains `url` to
`http`/`https` before the console follows it, so a malfunctioning or compromised provider
cannot hand back a `javascript:` or `data:` target. The host is deliberately unconstrained —
pinning it to a dotted domain would refuse a legitimate self-hosted provider endpoint.

**Completing a checkout does not activate anything by itself.** The provider's webhook is the
only writer of a subscription; see [The webhook pipeline](#the-webhook-pipeline).

## `POST /api/v1/billing/portal`

A short-lived link into the provider's own customer portal, where invoices, the payment
method, plan changes and cancellation live.

**Authentication.** Session cookie, `billing:manage`. Available while suspended.

**Idempotency.** No key. A portal session is free to create and has no side effect worth
replaying, so requiring one on the "manage billing" button would be friction for nothing.

| Parameter    | In   | Type   | Required | Default             | Notes                                        |
| ------------ | ---- | ------ | -------- | ------------------- | -------------------------------------------- |
| `returnPath` | body | string | no       | `/settings/billing` | A path, must start with `/`, ≤512 characters |

```bash
curl -X POST https://acme.app.example.com/api/v1/billing/portal \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"returnPath":"/settings/billing"}'
```

```json
{
  "url": "https://portal.example.com/s/019fee12-4c7d-7e08-a2b9-51d3f6c9074e",
  "expiresAt": "2026-08-22T11:00:00.000Z"
}
```

| Status | Code                   | Cause                                                   |
| ------ | ---------------------- | ------------------------------------------------------- |
| `200`  | —                      |                                                         |
| `400`  | `validation_failed`    | An absolute `returnPath`                                |
| `401`  | `unauthenticated`      | No session                                              |
| `403`  | `forbidden`            | No `billing:manage`                                     |
| `404`  | `not_found`            | The workspace has never completed a checkout            |
| `502`  | `upstream_unavailable` | Provider unreachable, or no return host to compose from |

**`404` is the answer for a workspace with no subscription, not `409`.** The resource the
caller asked for — their billing portal — does not exist yet, and the console's answer is to
offer checkout instead.

**The URL is generated on every click and never stored.** A portal URL is a live credential
for somebody's billing account, and one cached in a column outlives the click that needed it.

**Cancellation and plan changes are the portal's job, not this API's.** There is no cancel
route and no plan-change route on this surface: the provider is the system of record for
whether a subscription is paid, and two places that can end a subscription is one too many.
`changePlan` and `cancelSubscription` exist on the port and no HTTP route reaches them.

## The webhook pipeline

`POST /api/webhooks/billing` — one delivery from the payment provider.

**Authentication.** The signature over the raw body, and nothing else. The route is
`@PlatformRoute()`, so the global pipeline does not run: the provider posts to the platform
host with no cookie, so tenant resolution and session lookup have nothing to work with. The
tenant is derived from metadata _inside_ the signed payload, after verification, by the
worker.

**Idempotency.** Two layers. `INSERT … ON CONFLICT (provider, provider_event_id) DO NOTHING`
absorbs a redelivery at ingest — zero rows inserted _is_ the duplicate signal, with no
read-then-write race between two concurrent deliveries. The status-scoped claim in
`WebhookEventsRepository` then hands the row to exactly one worker. The dedupe key is the
`webhook-id` header, which Standard Webhooks names as the idempotency key and which exists
whether or not the provider puts an id in the body.

```text
verify signature → check timestamp → store to Postgres → answer 200 → enqueue → worker applies
```

**The order is the design.** Enqueueing straight to Redis would make a Redis outage silent,
permanent loss of billing events. Writing to Postgres first demotes Redis to a latency
dependency: if the enqueue fails the row is still there and `BillingSweeperService` picks it
up. Nothing is written before the signature passes, so an unsigned payload cannot grow the
table.

**The handler verifies, stores and returns — it applies nothing.** Polar's timeout is 10
seconds, it recommends answering within 2 by queuing, and **ten consecutive non-2xx responses
disable the endpoint**, which is the highest-severity failure this subsystem has.

**The response body is always empty.** It must never reveal whether a tenant exists, which
plan it is on, or whether the event was recognised.

| Status | Code                        | Cause                                                                           |
| ------ | --------------------------- | ------------------------------------------------------------------------------- |
| `200`  | —                           | Stored, or absorbed as a duplicate                                              |
| `401`  | `webhook_signature_invalid` | Bad signature, missing signature headers, a stale timestamp, or no `webhook-id` |

A refusal never says which. The difference between "wrong secret" and "stale timestamp" is a
reconnaissance signal for whoever is probing the endpoint, so the reason goes to the log at
`warn` and the caller gets one sentence.

**The timestamp check is two-sided.** `BILLING_WEBHOOK_TOLERANCE_MS` (default five minutes)
bounds how far the signed `webhook-timestamp` may be from now in _either_ direction —
Standard Webhooks signs the timestamp precisely so a captured, still-valid signature cannot be
re-presented indefinitely, and a timestamp in the future usually means clock skew worth
noticing.

### What the worker does

`BillingEventProcessor` claims the stored row and resolves its tenant in three branches, in
order:

1. **the metadata set at checkout** — the adapter reads it straight off the payload, so this
   is the path rather than the exception;
2. `subscriptions.provider_subscription_id`;
3. `subscriptions.provider_customer_id` — the index on that column exists for this.

Branches 2 and 3 are reads of _our_ table, which is why they live in the worker and not in
the adapter: a provider adapter that queried `subscriptions` would be one that knows our
schema. The adapter reports what the payload names (`readWebhookSubject`); the worker decides
who it belongs to.

It then translates the payload into a `BillingEvent`, applies it through
`SubscriptionSyncService`, and — **after that transaction commits, never inside it** — drives
`TenantLifecycleService.applyBillingEvent`. The lifecycle service opens its own transaction
and enqueues a notification keyed on the `lifecycle_events` row id; running it inside the
subscription transaction would enqueue a job that starts before its row is visible. A crash
between the two leaves the subscription written and the tenant not yet moved, which is the
safe direction: the row is still `processing`, the sweeper re-enqueues it, and both writes
are idempotent on replay.

Three outcomes, all of which answer the provider `200`:

| Outcome | When                                                                | `webhook_events.status` |
| ------- | ------------------------------------------------------------------- | ----------------------- |
| Applied | Translated and written                                              | `processed`             |
| Ignored | An event type this integration does not subscribe to, or unreadable | `processed`             |
| Parked  | No resolvable tenant, no resolvable plan, or attempts exhausted     | `failed`                |

A parked row keeps its raw payload and stays queryable, so it can be replayed once the cause
is fixed — through
[`POST /api/v1/admin/webhook-events/{id}/replay`](admin-api.md#post-apiv1adminwebhook-eventswebhookeventidreplay),
with the caveat that the sweep which collects a reset row scans `provider = 'whatsapp'` only,
so a billing row goes back to `received` and waits for the worker this integration adds — `last_error` names the reason (`unresolved_tenant`, `unresolved_plan: …`, or the
transient failure's description). Nothing is ever dropped. An event we did not subscribe to
is recorded as `processed` rather than parked, because parking every unsubscribed delivery
would fill the operator's `status = 'failed'` list with noise that hides the rows that
matter.

> ⚠️ **Ignored and applied are indistinguishable in `webhook_events.status`.** A payload the
> adapter cannot read is marked `processed` exactly like one it deliberately skipped, which is
> what TAR-663 reports against the Polar driver: with `BILLING_PROVIDER_DRIVER=polar` a real
> subscription payload parses to `null` and is silently marked processed, so a tenant that
> completed checkout is never activated. It is invisible today only because every environment
> runs the `fake` driver. **Do not turn the `polar` driver on until TAR-663 is fixed and
> verified.**

### An event older than the row it would write is dropped

`subscriptions.last_event_at` holds the provider timestamp of whatever last wrote the row,
and an event older than it is recorded for forensics and applied to nothing. Providers retry
with backoff and do not guarantee ordering: a retried `past_due` landing after a fresh
`active` would walk a tenant backwards into dunning it has already left — a lockout caused
entirely by delivery order.

The comparison is the **provider's** clock against the provider's clock. `updated_at` is our
write time, and comparing the two would be comparing two clocks.

### Normalised events and their lifecycle effect

The adapter translates every provider webhook into one of six `BILLING_EVENT_TYPES`, or drops
it. Nothing downstream — not the subscription writer, not the lifecycle, not the console —
ever sees a provider string.

| `BillingEvent.type`      | Tenant moves to | Notes                                                   |
| ------------------------ | --------------- | ------------------------------------------------------- |
| `subscription.activated` | `active`        |                                                         |
| `payment.succeeded`      | `active`        | A renewal that settled                                  |
| `subscription.past_due`  | `past_due`      | Starts the grace period                                 |
| `payment.failed`         | `past_due`      | Same, reported as a charge failure rather than a state  |
| `subscription.canceled`  | `cancelled`     | Access **has ended** — not "cancellation was requested" |
| `subscription.updated`   | nowhere         | Plan, seat and cancellation-banner changes only         |

`subscription.updated` moving no tenant is deliberate: mapping it to anything would make a
routine upgrade a lifecycle transition with an email attached. An event naming an illegal edge
— `payment.failed` for a tenant an operator cancelled an hour ago — is logged and treated as a
no-op rather than a failure.

### The Polar mapping

Provider-specific, and confined to `polar-event.mapper.ts`. Recorded here because it is what
the dashboard's subscribed-event list has to match.

| Polar event               | Becomes                  | Why                                                                         |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `subscription.active`     | `subscription.activated` | The activation signal                                                       |
| `subscription.past_due`   | `subscription.past_due`  | A renewal payment failed                                                    |
| `subscription.revoked`    | `subscription.canceled`  | Access permanently terminated — **this, and only this, is a cancellation**  |
| `subscription.canceled`   | `subscription.updated`   | Cancellation _requested_; still paid through the period end                 |
| `subscription.uncanceled` | `subscription.updated`   | Cancellation withdrawn; clears the banner columns                           |
| `subscription.updated`    | `subscription.updated`   | …or `payment.failed` when the new status is `past_due`                      |
| `order.paid`              | `payment.succeeded`      | A renewal. Carries the new period bounds, which is what rolls the allowance |

**`subscription.canceled` is not our `cancelled`.** Polar fires it when a customer _requests_
cancellation. `TENANT_STATUS_EFFECTS.cancelled` sets `apiAccess: false`, so mapping it across
would lock a tenant out of a period it has already paid for, on the same day it clicked
cancel.

**`subscription.created` is deliberately dropped.** A created subscription may not be active
yet, and acting on both would activate a tenant whose first payment has not settled.

Also not subscribed to: `customer_seat.*` (we own seat identity and the provider bills a
count), `checkout.*` (the subscription event is authoritative, and nothing has read a checkout
since TAR-651), and `customer.*`, `benefit*.*`, `product.*`, `refund.*`, `discount.*`,
`organization.updated` — none of them moves a tenant or changes what it may do.

The subscribed set is exported as `SUBSCRIBED_POLAR_EVENTS` beside the switch that handles it,
so the dashboard configuration and the code cannot drift silently. It is the list the
[runbook](../runbooks/billing-provider.md) tells an operator to tick.

Polar carries three subscription statuses this platform does not: `incomplete_expired` maps to
`incomplete`, `unpaid` to `past_due`, and `paused` to `canceled`. Each is its nearest
neighbour, and none of them widens what a tenant may do.

## Seats

**Seat identity is ours; the provider bills a count.** The provider's own seat-assignment and
invitation machinery is deliberately unused — TAR-22 already ships invitations, `users.status`,
`occupiesSeat`, revocation and expiry, and adopting a second invitation system would mean two
definitions of "holds a seat" and an admin reconciling two invite emails.

A seat is held by a member whose status is `active` **or `suspended`**, plus every invitation
that is unaccepted, unrevoked and unexpired. Both halves matter: counting only accepted members
would let an admin mint unlimited pending invites, and releasing a suspended member's seat
would let a tenant park staff to dodge the cap.

`SeatSyncService` and `PlanLimitsService.seatUsage` count those two populations with identical
predicates, deliberately: billing a different number from the one the invite check enforces is
how a tenant ends up refused an invite for a seat it is being charged for.

**The push is off the request path, always.** A membership change emits `SEATS_CHANGED_EVENT`
on the in-process domain bus; `SeatSyncService` subscribes and queues a job keyed on the
tenant, so five invitations in a minute collapse to one push. The job carries no count and
re-reads the database, so a job that runs late pushes the current number rather than a stale
one. Nothing imports `BillingModule` — `IdentityModule` and `PeopleModule` emit a fact about
seats and stay free of any knowledge that billing exists.

**Increases go out immediately; reductions are meant to wait for the period roll.** A tenant
that removes a member mid-period keeps the paid seat until the period ends, because reducing
immediately would issue a credit for a seat that may be re-filled next week. The failure
direction is under-billing, never over-serving: a seat the provider does not know about is one
we do not charge for, and the nightly reconciliation re-pushes it.

> ⚠️ **The reduction is not actually deferred to a period roll today.**
> `BillingEventProcessor` enqueues `allowDecrease: true` whenever the applied event carries a
> `currentPeriodStart` at all — which every subscription event does — rather than only when the
> period has advanced. A `subscription.updated` mid-period therefore releases a deferred
> reduction early. Recorded in the billing contract's amendment 1 as a low-severity
> fast-follow; the fix is to compare the incoming period start against the stored one and gate
> the enqueue on that.
>
> **TODO(author):** this fast-follow has no story id. Which issue owns it?

Seat enforcement itself is not on this surface. `POST /api/v1/users/invites` and invite
acceptance both call `PlanLimitsService.assertSeatAvailable` inside the transaction that
consumes the seat, under a transaction-scoped advisory lock keyed by tenant, and refuse with
`402 plan_limit_exceeded`. The full rules are in the
[tenant lifecycle reference](tenant-lifecycle.md#where-each-limit-is-enforced).

## Conversation volume

A conversation is opened by a customer writing in, so `usage_counters.conversations_opened` is
incremented by the **inbound** writer, inside the transaction that stores the message — a
replay that trips a unique constraint rolls the increment back with it.

The cap is checked at the **outbound send**, and never on ingest. Refusing an inbound write to
enforce a quota would lose a real person's message to fix a billing problem. What a spent
allowance withholds is the tenant's ability to reply.

### The policy is configuration

`BILLING_VOLUME_POLICY` is `warn` or `block`, and it is a deployment-wide setting rather than
a per-tenant one.

| Policy           | At the cap                                                             |
| ---------------- | ---------------------------------------------------------------------- |
| `warn` (default) | Everything keeps working. The counter still crosses and still notifies |
| `block`          | Outbound sends answer `402 plan_limit_exceeded`                        |

**`warn` is the default deliberately:** blocking a helpdesk's replies is the most damaging
thing this system can do to a tenant's _customers_, and a reseller will want a conversation
before it happens. Under `warn` the check is skipped entirely rather than performed and
discarded — it is a counter read on the busiest path in the product.

The volume check takes **no advisory lock**, unlike the seat check. Seats is a level, and two
concurrent acceptances that both read "2 of 3" step over a guarantee. Volume is a monotonic
counter against a ceiling that gates and warns and never bills, so an overshoot of a handful
under concurrency costs nothing.

### The two notices

`VolumeNotifierService` emails every `active` admin of the tenant when a crossing happens:

| Template               | Crossed                                           |
| ---------------------- | ------------------------------------------------- |
| `volume_warning`       | `ceil(cap × BILLING_VOLUME_WARN_AT)`, default 80% |
| `volume_limit_reached` | The cap itself                                    |

Both carry the effective policy in their data, because "you have used 800 of 1,000" means
something very different depending on whether the thousandth conversation stops replies going
out.

**Once per period, without a table to remember it.** The event carries the count _after_ an
increment of one, so a crossing is `opened - 1 < threshold <= opened` — true for exactly one
event per period by construction, with the upsert's row lock making it hold under concurrency.
A counter corrected downwards by a reconciliation can re-notify; a tenant told twice that they
are near their limit is a far better failure than one told nothing.

The cap is checked before the warning line, so a plan small enough that the two coincide sends
the notice that matters rather than the softer one. A mailer outage is caught and logged rather
than rethrown: the subscriber is dispatched from the inbound path without an await, and a
customer's message must not fail because a courtesy email did.

## Dunning and suspension

There is no suspension logic in the billing module, and that is the point.

1. A failed renewal arrives as `subscription.past_due` or `payment.failed`.
2. `TenantLifecycleService` moves the tenant to `past_due` and stamps
   `tenants.grace_period_ends_at` at `now + LIFECYCLE_POLICY.pastDueGraceDays`.
3. If nothing recovers it, `TenantLifecycleSweeper` — a timer, not a billing code path — moves
   the tenant to `suspended` when that instant passes.
4. A payment that succeeds arrives as `payment.succeeded`, which moves the tenant back to
   `active` and clears the grace timer in the same transaction. A stale timer is a tenant
   suspended a fortnight after it paid.

**`pastDueGraceDays` is 21, and the number is Polar's rather than a guess.** Polar retries a
failed renewal on days 2, 7, 14 and 21 from first failure. At 14 the timer fired a week early
and suspended tenants whose day-21 retry would have succeeded — locking an admin out of the
console on the exact day they were about to be charged, and leaving them unable to reach
billing to fix it. The organisation's Polar benefit-revocation grace period is set to 21 to
match, so `subscription.revoked` should arrive before this timer ever fires: the sweep is the
fallback for a missed webhook rather than the normal route to `suspended`.

`subscriptions.past_due_since` is **not** the dunning clock. It is a support and reporting
column that keeps the _first_ timestamp across repeated `past_due` reports — "how long has this
been failing", not "when did we last hear". Duplicating a deadline in two columns is how the
two drift apart.

The state machine itself, its transitions and its effects table are
[ADR 0012](../architecture/0012-tenant-lifecycle-state-machine.md) and the
[tenant lifecycle reference](tenant-lifecycle.md).

## Reconciliation and the sweeper

Two scheduled BullMQ jobs on the `billing` queue, registered by `BillingQueueRunner` on
application bootstrap. Both are repeatables rather than `@Cron`, so BullMQ's scheduler is the
distributed lock and they do not run once per replica.

**The sweeper** (`WEBHOOK_SWEEP_INTERVAL_MS`, shared with the WhatsApp sweep) re-enqueues
`webhook_events` rows still `received`, or stuck in `processing` past
`WEBHOOK_STUCK_AFTER_MS`, 200 at a time. It is what turns a Redis outage into billing events
arriving _late_ rather than not at all. It re-enqueues under a different job id from the ingest
path, because `removeOnFail` retains a failed job under its id and BullMQ ignores an `add` for
an id it still holds — the row whose terminal write failed is exactly the one the sweeper
exists for.

**The reconciliation** (`BILLING_RECONCILE_INTERVAL_MS`, nightly) compares up to 200
subscriptions against the provider's, oldest `last_event_at` first, because the subscriptions
that have gone quiet are the ones a missed webhook would have left stale. It exists because a
missed webhook is silent: a subscription that stopped being updated looks exactly like one that
has not changed.

| Field          | Winner       | Why                                                                       |
| -------------- | ------------ | ------------------------------------------------------------------------- |
| Status, period | The provider | It is the system of record for whether a subscription is paid             |
| Seats          | **Us**       | The count is derived from `users` and `invites`; theirs is what we pushed |

A seat disagreement is re-pushed rather than accepted — accepting it would silently lower a
tenant's cap to whatever the last failed push left behind. Every correction is logged
individually: a bug here is a wrong invoice, and a quiet run that corrected forty tenants is
the thing to investigate.

It applies through `SubscriptionSyncService`, so the `last_event_at` guard applies to it too: a
reconciliation that races a fresh webhook loses, which is the right way round. A tenant whose
`provider_subscription_id` the provider does not recognise is reported and left alone — that is
usually sandbox credentials pointed at production data, or the reverse, and neither is safe to
guess at.

**No worker means no activation.** With `REDIS_URL` unset the API logs one warning at boot and
still accepts and stores webhooks — nothing is lost — but no subscription changes state until a
process with Redis picks them up.

## Errors

Every billing failure maps through `apps/api/src/billing/billing.http.ts`, one table rather
than a `catch` per handler, so the same condition cannot answer 402 on one route and 409 on
another. **No new error codes**: the published taxonomy in
`packages/contracts/src/error-codes.ts` covers every case.

| Domain error                      | Code                        | Status | Meaning                                                             |
| --------------------------------- | --------------------------- | ------ | ------------------------------------------------------------------- |
| `BillingProviderUnavailableError` | `upstream_unavailable`      | `502`  | Provider down, plan unmapped, or no credentials in this environment |
| `PlanNotFoundError`               | `not_found`                 | `404`  | No active plan with that key                                        |
| `NoSubscriptionError`             | `not_found`                 | `404`  | Portal asked for before any checkout completed                      |
| `PlanDowngradeBlockedError`       | `plan_limit_exceeded`       | `402`  | The chosen plan is smaller than current usage                       |
| `PlanLimitExceededError`          | `plan_limit_exceeded`       | `402`  | A ceiling refused the write                                         |
| `IdempotencyKeyReusedError`       | `idempotency_key_reused`    | `409`  | Same key, different plan                                            |
| `IdempotentRequestInFlightError`  | `conflict`                  | `409`  | Same key, still running                                             |
| `BillingWebhookRefusedError`      | `webhook_signature_invalid` | `401`  | Signature, timestamp, or a missing `webhook-id`                     |

Anything not in that table is re-thrown and reaches the global filter as the 500 a fault should
be.

**Three mappings are worth arguing about.** A blocked downgrade is `plan_limit_exceeded` rather
than `validation_failed`: the request is well formed and the caller is permitted, and the plan
simply does not fit the workspace. An unreachable provider is `upstream_unavailable`
_including_ the case where the plan has no provider product id — both mean "we could not open a
checkout, try later", and neither is the caller's fault. No subscription is `not_found` rather
than `conflict`, because the portal is a resource that does not exist until a checkout
completes.

**No billing error carries a provider name, a token, a customer record or an amount.** These
messages reach a tenant admin's screen. The cause — which of "Polar is down", "this plan has no
product id" and "no access token was provisioned here" it was — goes to the log, where an
operator can read it.

## Configuration

Every key the billing subsystem reads. The full contract for each is `.env.example` and
`apps/api/src/config/env.schema.ts`; how an operator provisions them is
[Connecting the billing provider](../runbooks/billing-provider.md).

| Key                             | Default    | Notes                                                                       |
| ------------------------------- | ---------- | --------------------------------------------------------------------------- |
| `BILLING_PROVIDER_DRIVER`       | `fake`     | `polar` or `fake`. Selecting `polar` makes the two credentials mandatory    |
| `POLAR_ENVIRONMENT`             | `sandbox`  | `sandbox` or `production`. The switch TAR-37 requires to be configuration   |
| `POLAR_ACCESS_TOKEN`            | —          | Organization Access Token. Optional unless the driver is `polar`            |
| `POLAR_WEBHOOK_SECRET`          | —          | Standard Webhooks signing secret, `whsec_…`. Absent refuses every delivery  |
| `POLAR_REQUEST_TIMEOUT_MS`      | `10000`    | Upper bound on one provider call                                            |
| `BILLING_VOLUME_POLICY`         | `warn`     | `warn` or `block`                                                           |
| `BILLING_VOLUME_WARN_AT`        | `0.8`      | Fraction of the allowance that sends the warning. Strictly between 0 and 1  |
| `BILLING_RECONCILE_INTERVAL_MS` | `86400000` | How often the nightly comparison runs. Minimum one minute                   |
| `BILLING_WEBHOOK_TOLERANCE_MS`  | `300000`   | Signed-timestamp window. Minimum 30 seconds                                 |
| `WEBHOOK_MAX_ATTEMPTS`          | `5`        | Shared with the WhatsApp pipeline                                           |
| `WEBHOOK_SWEEP_INTERVAL_MS`     | —          | Shared with the WhatsApp sweep, so recovery does not depend on the provider |
| `WEBHOOK_STUCK_AFTER_MS`        | —          | How long a `processing` row waits before a sweep reclaims it                |

**Both defaults fail in the safe direction.** An environment that was never given credentials
runs the whole flow on the fake adapter rather than failing at the first request, and a missing
`POLAR_ENVIRONMENT` means sandbox, because the failure direction of an absent value has to be
"no live charges". `BILLING_PROVIDER_DRIVER=polar` with either credential missing is a **failed
boot**, not a warning: an API that thinks it is taking payments and cannot would come up
healthy and answer every checkout with what reads like a provider outage.

## The provider port

`BillingProvider` in `packages/contracts/src/billing.ts` is the only surface through which the
platform talks to a payment provider, bound once in `BillingModule` by a factory reading
`BILLING_PROVIDER_DRIVER`. Every method is expressed in our vocabulary — `planKey`, `seats`,
`tenantId` — rather than the provider's, and **provider ids are opaque strings only the adapter
interprets**.

| Method                   | Called by                                             |
| ------------------------ | ----------------------------------------------------- |
| `createCheckout`         | `POST /billing/checkout`                              |
| `createPortalSession`    | `POST /billing/portal`                                |
| `getSubscription`        | The nightly reconciliation                            |
| `updateSeats`            | `SeatSyncService`                                     |
| `cancelSubscription`     | No HTTP route; cancellation is the provider portal's  |
| `changePlan`             | No HTTP route, for the same reason                    |
| `verifyWebhookSignature` | `BillingWebhookService.ingest`                        |
| `readWebhookSubject`     | `BillingEventProcessor`, before the parse             |
| `parseWebhookEvent`      | `BillingEventProcessor`, after the tenant is resolved |
| `resolveCheckout`        | **Nothing.** See below                                |

`resolveCheckout` has no caller. It was the fast path for the console on return from the hosted
page; TAR-619 chose the webhook plus a refresh instead, and TAR-651 removed
`POST /billing/checkout/complete`, the only route that reached it. The method and its two
adapter implementations are kept because removing a published port method is a contract
decision rather than an API-surface one.

Adding a second provider is a sibling of `apps/api/src/billing/providers/polar/` and no edit
anywhere else.

### `FakeBillingProvider`, and its hosted page

The default driver outside production. It is not a stub returning constants: it keeps enough
state to make the flow real — a checkout it opened resolves into an activated subscription with
the plan and seats that were asked for, seats update, a cancellation sets `cancelAtPeriodEnd`,
and the same subscription comes back from `getSubscription`.

A fake provider cannot do the one thing that activates a subscription: **call back**. So it has
a hosted page too. `createCheckout` points the browser at `GET /api/billing/fake-checkout/{id}`
(`FakeCheckoutController`), and settling there produces an activation delivered through
`BillingWebhookService.ingest`, signed with the adapter's own key — the same bytes, the same
signature check, the same replay absorption, the same queue and the same
`SubscriptionSyncService` a real delivery goes through. Append `?outcome=cancelled` to that URL
to walk the cancel path instead.

The route is mounted unconditionally and answers `not_found` unless the bound adapter _is_ the
fake, checked by `instanceof` rather than by re-reading the driver, so no configuration can
make the gate and the binding disagree.

State lives in process memory, so a restart forgets every subscription and two replicas
disagree. That is correct for its purpose and is why the production binding is
`PolarBillingProvider`.

## Related

- [Choose a plan and manage billing](../guides/manage-your-plan-and-billing.md) — the same
  surface for the tenant admin who uses the console
- [Connecting the billing provider](../runbooks/billing-provider.md) — the operator's
  credential and endpoint setup
- [Tenant lifecycle reference](tenant-lifecycle.md) — entitlements, where each limit is
  enforced, and the states dunning moves a tenant through
- [Data model reference](data-model.md#billing--tar-37) — `plans`, `subscriptions`,
  `usage_counters`, `webhook_events`
- [ADR 0012 — tenant lifecycle state machine](../architecture/0012-tenant-lifecycle-state-machine.md)
