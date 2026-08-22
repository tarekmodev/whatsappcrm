# Connecting the billing provider

What a platform operator provisions before this platform can take a payment, and how the
sandbox and production estates are kept apart. Written for a **platform operator**: you run
the Render workspace and a terminal, and nothing here asks you to read the codebase.

Polar.sh is the payment rail. It acts as merchant of record, which is what removes
per-country tax registration and invoicing from the reseller — the reason it was chosen over
a card processor. The application talks to it through one adapter and never anywhere else,
so everything below is credentials, one dashboard endpoint, and one seed edit.

The HTTP surface behind all of this is
[the billing API reference](../reference/billing-api.md); what a tenant admin sees is
[Choose a plan and manage billing](../guides/manage-your-plan-and-billing.md).

## The state today

**No environment is connected.** Every environment runs `BILLING_PROVIDER_DRIVER=fake`,
which is the default and the safe direction: an environment that was never given credentials
runs the whole checkout-to-activation flow locally, with no network and no money moving,
rather than failing at the first request.

Turning the real rail on is deliberate, and it is four things:

1. a Polar Organization Access Token per environment;
2. a webhook signing secret per environment;
3. one Polar **product** id per plan tier, seeded into `plans.provider_product_id`;
4. flipping `BILLING_PROVIDER_DRIVER` to `polar`.

None of the four exists yet. They are outstanding from Tarek, with no fixed date.

> ⚠️ **Do not flip the driver yet, even once the credentials arrive.** TAR-663 is open: with
> `BILLING_PROVIDER_DRIVER=polar`, a real Polar subscription webhook parses to nothing and is
> marked processed anyway, so a tenant that completes checkout is never activated and no
> parked row records that it happened. The bug is invisible on the `fake` driver, which is
> why it survived review. Connect the credentials, verify TAR-663 is fixed, then flip.

## The credentials, exactly

Four environment variables and one database column. All four variables are set per
environment in that environment's Render environment group; none is ever copied between
estates.

| What                                   | Where it goes                          | Where it comes from                                                                                          |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Organization Access Token              | `POLAR_ACCESS_TOKEN`                   | Polar dashboard → your organisation → **Settings → Developers**. Sandbox tokens come from `sandbox.polar.sh` |
| Webhook signing secret (`whsec_…`)     | `POLAR_WEBHOOK_SECRET`                 | Shown once when you create the webhook endpoint, below. `polar listen` prints one for local work             |
| Which estate this environment talks to | `POLAR_ENVIRONMENT`                    | You set it: `sandbox` or `production`                                                                        |
| Whether the real rail is on at all     | `BILLING_PROVIDER_DRIVER`              | You set it: `polar` or `fake`                                                                                |
| One product id per plan tier           | `plans.provider_product_id` (database) | Polar dashboard → **Products**. The product's UUID, not a price id                                           |

**Sandbox and production tokens are separate and not interchangeable.** A token from the
wrong estate fails at Polar rather than charging a real customer, which is the failure
direction to keep.

**`POLAR_ENVIRONMENT` defaults to `sandbox`.** That is the sandbox/production switch, it is a
configuration value rather than a build, and production is the only environment that sets it
explicitly — the failure direction of a missing value has to be "no live charges".

**`BILLING_PROVIDER_DRIVER=polar` makes the two credentials mandatory.** The API refuses to
boot without them. That is deliberate: an API that thinks it is taking payments and has no
token would come up healthy and answer every checkout with what reads like a provider
outage.

Which environment gets which estate follows the existing rule in
[Environments](environments.md): development and staging take sandbox, production takes live.

## Creating the webhook endpoint

In the Polar dashboard for the estate you are configuring, **Settings → Webhooks → Add
endpoint**.

**URL.** `https://<the environment's API host>/api/webhooks/billing` — for example
`https://whatsappcrm-api-staging.onrender.com/api/webhooks/billing`. There is no `/v1` in it,
and that is not a mistake: the version prefix is a contract with our own clients, and this
URL is registered once here and changing it means an outage.

**Format.** Raw. The signature is verified over the exact bytes.

**Events.** Tick exactly these seven and nothing else:

- `subscription.active`
- `subscription.updated`
- `subscription.uncanceled`
- `subscription.canceled`
- `subscription.past_due`
- `subscription.revoked`
- `order.paid`

That list is `SUBSCRIBED_POLAR_EVENTS` in
`apps/api/src/billing/providers/polar/polar-event.mapper.ts`, exported so this page and the
code cannot drift. Anything else Polar sends is answered `200` and recorded as processed —
subscribing to more costs nothing but noise, and subscribing to fewer loses a state change.

**Copy the signing secret when it is shown.** It starts `whsec_` and Polar shows it once.
Paste it into `POLAR_WEBHOOK_SECRET` for that environment and redeploy.

### While you are in the dashboard

Set the organisation's **benefit revocation grace period to 21 days**. Polar retries a failed
renewal on days 2, 7, 14 and 21, and this platform's own dunning window
(`LIFECYCLE_POLICY.pastDueGraceDays`) is 21 to match. With the two aligned, Polar's
`subscription.revoked` arrives before our timer fires, and the timer is a fallback for a
missed webhook rather than the normal route to suspending a tenant. Set it shorter and a
tenant is suspended by us while Polar is still trying to collect.

## Mapping plans to Polar products

Create one Polar product per plan tier, then write each product's UUID into that plan's
`provider_product_id`.

**Checkout takes product ids, not price ids.** A plan with a null `provider_product_id` makes
`POST /api/v1/billing/checkout` answer `502 upstream_unavailable` and log
`plan <key> has no provider_product_id; seed it before enabling checkout` — the plan is
visible on the pricing page and cannot be bought.

The plan rows themselves are seeded by `pnpm --filter @whatsappcrm/api db:seed`, which
upserts `plans` rather than replacing it, so filling the product ids in is a one-line edit per
tier in `apps/api/src/seed/demo-dataset.ts` followed by a re-seed, or a direct `UPDATE` in a
deployed environment.

> **TODO(author):** the seeded tiers (Starter, Growth, Scale, and their prices and
> allowances) are the shape rather than the pricing — the billing contract's open question 6
> leaves the numbers to a pricing decision that has not been made. Confirm the real tiers
> before creating Polar products against them, since a product's price is not something you
> want to re-cut after tenants are on it.

`provider_product_id` is opaque to everything except the adapter: nothing branches on it, it
never appears in an API response, and plan logic keys off `plans.key` instead.

## Verifying a connection

Against a sandbox estate, with the driver flipped and the API redeployed.

**1. Check the API booted**, which is what proves both credentials are present and non-empty.

```bash
curl -s https://whatsappcrm-api-staging.onrender.com/api/health/ready
# {"status":"ok",...,"checks":{"database":{"status":"ok"},"queue":{"status":"ok"}}}
```

The queue check matters as much as the database one. **With no Redis there is no billing
worker**: webhooks are accepted and stored and nothing is ever applied — the API logs one
warning at boot saying exactly that, and a tenant that has paid does not see its plan take
effect.

**2. Buy something.** As a tenant admin in that environment, open **Settings → Plans and
billing** and choose a tier. Polar's sandbox takes the test card `4242 4242 4242 4242` with
any future expiry and any CVC.

**3. Check the delivery.** In the Polar dashboard, the endpoint's delivery log should show
`subscription.active` answered `200`.

**4. Check the write.** In that environment's database the tenant should now have a
`subscriptions` row with a status and both period bounds, and its `tenant_entitlements` row
should carry the purchased tier's allowances.

If step 3 shows a `401`, the signing secret does not match the endpoint. If it shows repeated
`401`s, fix it promptly: **ten consecutive non-2xx responses disable the endpoint**, and
Polar emails the organisation's members when it does. Re-enable it in the dashboard after
correcting the secret; the deliveries missed while it was disabled are recovered by the
nightly reconciliation rather than by replaying them.

If step 3 shows `200` but step 4 shows nothing, that is TAR-663 — a parse failure recorded as
success. Check the API log for the billing worker; a payload the adapter could not read
leaves no parked row to find.

## Switching an environment from sandbox to production

Four values change together, in one edit to that environment's Render environment group:

| Key                       | To                                     |
| ------------------------- | -------------------------------------- |
| `POLAR_ENVIRONMENT`       | `production`                           |
| `POLAR_ACCESS_TOKEN`      | The **live** organisation's token      |
| `POLAR_WEBHOOK_SECRET`    | The **live** endpoint's signing secret |
| `BILLING_PROVIDER_DRIVER` | `polar`                                |

Then redeploy. No rebuild, no code change — the same rotation shape every other credential in
[Environments](environments.md) follows.

Before you do: create the live endpoint and the live products first, and seed
`provider_product_id` in the **production** database with the **live** product ids. A
production API pointed at sandbox product ids opens checkouts against products that do not
exist in that estate.

**Never copy a live token down into staging.** A live token in a test environment takes real
money from real customers on a test click. The nightly reconciliation makes the mix-up
loud in one direction — it logs
`has a provider subscription id the provider does not return … usually sandbox credentials
pointed at production data or the reverse` — but the charge has already happened by then.

## Local development

Nothing above is needed to work on billing locally. `BILLING_PROVIDER_DRIVER=fake` is the
default in `.env.example`, and the fake adapter runs the whole flow: choosing a plan opens a
stand-in hosted checkout page the API serves at `/api/billing/fake-checkout/<id>`, and
settling it delivers a signed activation through the ordinary webhook receiver — the same
signature check, the same replay absorption, the same queue and the same writer a Polar
delivery goes through. Add `?outcome=cancelled` to walk the cancel path. The page answers
`404` on the `polar` driver.

A local worker needs `REDIS_URL` set, for the reason above.

To exercise the real adapter against sandbox from a laptop, Polar's CLI forwards deliveries
and prints a signing secret to use as `POLAR_WEBHOOK_SECRET`:

```bash
polar listen http://localhost:3001/api/webhooks/billing
```

> **TODO(author):** unverified. The `polar listen` invocation and the dashboard navigation
> paths above are taken from the billing contract's record of Polar's documentation as read
> on 22 August 2026, not from a session anyone has run — nobody has had credentials to run
> one. Re-check both against Polar's current documentation when the first token arrives, and
> correct this page in the same change.

## What is deliberately not here

**Per-conversation overage billing.** Meta's own WhatsApp conversation charges are a
pass-through cost this platform records and does not bill. `usage_counters` captures the
numbers from day one so switching it on later is configuration rather than a migration.

**Manual or offline invoicing, and purchase orders.** Everything a tenant needs — invoices,
payment method, plan change, cancellation — is in Polar's own customer portal, reached from
the console. There is no invoice surface in this product and no route that cancels a
subscription.

**Per-tenant volume policy.** `BILLING_VOLUME_POLICY` is one deployment-wide setting, `warn`
or `block`, and it defaults to `warn`. Changing it changes it for every tenant in that
environment.

## Related

- [Billing API reference](../reference/billing-api.md) — the endpoints, the webhook pipeline,
  and every configuration key
- [Environments](environments.md) — which estate each environment takes, and the rotation
  rules every credential follows
- [Tenant lifecycle reference](../reference/tenant-lifecycle.md) — what `past_due` and
  `suspended` do to a tenant
