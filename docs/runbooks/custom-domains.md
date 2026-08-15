# Custom domains and TLS

How a tenant's own hostname comes to serve the platform, and what a platform operator
does to make it happen. Written for a **platform operator**: you run the Render
workspace and read a terminal, and nothing here asks you to read the codebase.

Two kinds of hostname reach the product, and only one of them is work:

| Hostname                   | Example                | Certificate                       | Operator work               |
| -------------------------- | ---------------------- | --------------------------------- | --------------------------- |
| Platform subdomain         | `acme.app.example.com` | One wildcard, `*.app.example.com` | Once per environment        |
| Tenant's own custom domain | `support.acme.com`     | One certificate per domain        | Once per domain, per tenant |

Every tenant is issued a platform subdomain when it is provisioned, and that subdomain
is never removed — it is the host that keeps working while a customer's DNS is still
propagating, and the one a tenant falls back to if its own domain lapses.

The technical contract behind all of this is TAR-416; the routing and TLS half of it is
TAR-419, which is what this document is.

## What the edge decides, and what it does not

This is the part worth reading before touching anything, because it is what makes
attaching a domain safe.

**The edge does not choose a tenant.** Every hostname — platform subdomain and custom
domain alike — is attached to the same web service in one environment, and that service
serves one build of one application. Attaching a domain decides only whether a TLS
connection is possible at all.

**The application chooses the tenant, from the host, against the database.** A hostname
resolves to a tenant only if there is a row for it that has been verified, and an
unverified row resolves to nothing. So the two halves are held by different parties and
neither can forge the other:

- A domain **verified but not attached** receives no traffic. Nothing has been broken;
  the customer's browser cannot reach us yet.
- A domain **attached but not verified** answers `404 tenant_not_found` on every route.
  Attaching a hostname you were not asked to attach therefore leaks nothing — it serves
  no tenant at all.

There is exactly one way to get this wrong from the edge, and it is worth stating on its
own because nothing downstream catches it:

> ⚠️ **Attach a domain to the wrong environment's web service and it serves the wrong
> data under the customer's brand.** `whatsappcrm-web-staging` and `whatsappcrm-web-prod`
> run the same code against different databases. A production tenant's domain attached to
> staging resolves — staging has its own tenants — and the customer sees a working,
> branded, wrong product. Confirm the service name before every attach. This is the check
> that has no automated backstop.

## Once per environment: the wildcard certificate

Every tenant's platform subdomain is covered by one wildcard, rather than a certificate
per tenant. That is deliberate and the reason is a rate limit: Let's Encrypt allows **50
new certificates per registered domain per 7 days** (renewals do not count against it).
Issuing one per tenant would put a hard ceiling of 50 signups a week on the platform and
put certificate issuance on the provisioning critical path. One wildcard has neither
problem, and the ceiling disappears rather than moving.

**Render issues and renews wildcard certificates automatically**, over the DNS-01
challenge — verified against Render's custom-domains documentation, August 2026. This
was the open question TAR-416 left for TAR-419, and the answer means the fallback it
described (attaching each subdomain individually, and accepting a 50-per-week signup
ceiling) is not needed. If Render's behaviour ever changes, that fallback is what to
reach for.

Do this once per environment, against the environment's **web** service.

1. Render Dashboard → `whatsappcrm-web-<env>` → **Settings** → **Custom Domains** →
   **Add Custom Domain**.
2. Enter the wildcard for that environment's `PLATFORM_DOMAIN`, for example
   `*.app.example.com`.
3. Render shows three DNS records. Add all three in the zone that holds
   `app.example.com` — the names below are relative to `example.com`:

   | Type    | Name                      | Value                                 |
   | ------- | ------------------------- | ------------------------------------- |
   | `CNAME` | `*.app`                   | `whatsappcrm-web-prod.onrender.com`   |
   | `CNAME` | `_acme-challenge.app`     | `<service-id>.verify.renderdns.com`   |
   | `CNAME` | `_cf-custom-hostname.app` | `<service-id>.hostname.renderdns.com` |

   **Copy the last two values from the Dashboard rather than typing them.** They carry
   the service's own id, they differ per environment, and a wrong one fails as a
   certificate that never issues rather than as an error.

   The `_acme-challenge` record is what delegates certificate issuance and **renewal** to
   Render. Removing it later does not break anything immediately — it breaks the renewal,
   silently, up to three months afterwards.

4. Remove any `AAAA` record on those names. Render's edge is IPv4 and an `AAAA` record
   sends half your visitors somewhere that does not answer.
5. Click **Verify** in the Dashboard. If it fails, DNS has not propagated; wait and retry.
6. Confirm the certificate covers the wildcard and that a subdomain actually serves:

   ```bash
   openssl s_client -connect acme.app.example.com:443 -servername acme.app.example.com \
     </dev/null 2>/dev/null \
     | openssl x509 -noout -subject -ext subjectAltName -dates
   ```

   The `subjectAltName` must contain `DNS:*.app.example.com`, and `notAfter` must be in
   the future. Renewal is Render's; the check here is that issuance happened at all.

**What the wildcard does not cover.** `*.app.example.com` matches exactly one label:
`acme.app.example.com` is covered, `app.example.com` itself is not, and
`eu.acme.app.example.com` is not. Tenant slugs are a single DNS label, so this is only a
constraint on the `PLATFORM_DOMAIN` you choose — pick one where every tenant sits exactly
one label below it.

## Per tenant: attaching a verified custom domain

A tenant adds its domain in the console, which issues a verification token and shows the
DNS records below. When the tenant has published them and the platform has confirmed
ownership, the domain becomes **verified** — and then it waits for you, because attaching
it at the edge is the one step the application deliberately does not do (see
"Why this is manual").

1. **Find what is waiting.** Verified domains that have not been activated:

   ```bash
   curl -sS https://whatsappcrm-api-prod.onrender.com/api/v1/admin/domains?status=verified \
     -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN"
   ```

2. **Confirm the environment.** Read the warning above. The service must be the web
   service of the environment that holds this tenant.

3. **Check the tenant's DNS actually points at us** before adding anything, so a failure
   is diagnosed here rather than as a certificate that never issues:

   ```bash
   dig +short TXT _whatsappcrm-challenge.support.acme.com
   # → "whatsappcrm-domain-verification=<token>"

   dig +short CNAME support.acme.com
   # → whatsappcrm-web-prod.onrender.com.
   ```

4. **Attach it.** Render Dashboard → `whatsappcrm-web-<env>` → **Settings** →
   **Custom Domains** → **Add Custom Domain** → `support.acme.com` → **Verify**.

5. **Confirm the certificate.** Issuance is usually a minute or two after verification.

   ```bash
   openssl s_client -connect support.acme.com:443 -servername support.acme.com \
     </dev/null 2>/dev/null | openssl x509 -noout -subject -dates
   ```

6. **Confirm it serves the right tenant.** This is the check that proves routing, not
   only TLS — it goes through the whole path the customer's browser takes:

   ```bash
   curl -sS -i https://support.acme.com/api/v1/tenant/public
   ```

   `200` with that tenant's branding is success. `404` with `"code":"tenant_not_found"`
   means TLS is fine and tenant resolution is not — go to
   [When a domain does not work](#when-a-domain-does-not-work).

7. **Record the activation**, which is what stops the domain appearing on the queue in
   step 1 and what tells the tenant's console the domain is live:

   ```bash
   curl -sS -X POST \
     https://whatsappcrm-api-prod.onrender.com/api/v1/admin/tenants/acme/domains/support.acme.com/activate \
     -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN"
   ```

> The three `/api/v1/admin/domains*` calls above are TAR-420's to build and are not
> deployed yet. Until they are, steps 1 and 7 are a message from the tenant and a note in
> the ticket; steps 2–6 are unchanged and are the ones that matter.

### The records a tenant is given

The console shows these; they are repeated here so an operator reading a support ticket
can check a customer's zone without a console session. Both come from the API, so treat
the console as authoritative if they ever disagree.

**Ownership — one TXT record, removed once verified is not required but is harmless.**

| Type  | Name                                      | Value                                     |
| ----- | ----------------------------------------- | ----------------------------------------- |
| `TXT` | `_whatsappcrm-challenge.support.acme.com` | `whatsappcrm-domain-verification=<token>` |

The token is 32 hex characters and is **not a credential** — it is published in public
DNS by design, it is scoped to one hostname and one tenant, and it may be shown to the
tenant again as often as they ask. An unverified claim expires after 7 days and the
hostname is released for anyone else to claim.

**Routing — one CNAME record.**

| Type    | Name               | Value                             |
| ------- | ------------------ | --------------------------------- |
| `CNAME` | `support.acme.com` | value of `PLATFORM_EDGE_HOSTNAME` |

`PLATFORM_EDGE_HOSTNAME` is set per environment in `render.yaml` and is that
environment's public web-service host, for example `whatsappcrm-web-prod.onrender.com`.
It is a bare hostname: no scheme, no trailing dot. **Changing it in production invalidates
the CNAME every existing tenant has already published**, so treat it as fixed once the
first custom domain is live.

> **Subdomains only.** `support.acme.com` works; `acme.com` does not. A root domain cannot
> take a `CNAME`, so it needs either an `ALIAS`/`ANAME` record — which many registrars do
> not offer — or an `A` record to Render's load-balancer IP, which would bake an address
> we do not control into every tenant's zone and make a future change a migration we
> cannot perform on their behalf. The claim is refused with a message saying to use a
> subdomain. See [Open](#open) for what apex support would take.

## Detaching a domain

A tenant removing a domain in the console stops it resolving **immediately** — the row
goes and nothing serves that host any more. That is the security-relevant half and it
needs nothing from you.

Detaching at the edge is tidying, and it is worth doing:

1. Render Dashboard → the web service → **Custom Domains** → remove the hostname.
2. `POST /api/v1/admin/tenants/{slug}/domains/{hostname}/deactivate` to clear the
   activation record.

Left attached, the domain costs a per-domain fee and generates renewal failures once the
customer repoints their DNS. It does not serve anything and it does not block another
tenant from claiming the hostname later.

Never remove the wildcard, and never remove a tenant's **platform subdomain** row: a
tenant whose only hostname is gone is unreachable and cannot be recovered without operator
help. The API refuses to delete a platform domain for this reason.

## When a domain does not work

Work down this list; each step distinguishes a different layer.

| Symptom                                                        | Layer          | Check                                                                                                  |
| -------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| Browser cannot connect at all                                  | DNS            | `dig +short CNAME support.acme.com` — does it name the environment's edge host?                        |
| TLS warning, or `certificate has expired`                      | Certificate    | Is the domain still attached in the Dashboard? Is `_acme-challenge` still present for the wildcard?    |
| `404` with `"code":"tenant_not_found"`                         | Tenant routing | Is the domain verified, and is it the right environment? See below.                                    |
| `404 tenant_not_found` on **every** host, including subdomains | Configuration  | `TRUSTED_PROXY_SECRET` disagrees between the API and web services — see docs/runbooks/environments.md. |
| Works on `acme.app.example.com`, not on `support.acme.com`     | Verification   | The custom domain row is unverified, or was deleted by the tenant.                                     |

`tenant_not_found` is deliberately the same answer for "no such host", "unknown host" and
"host not yet verified" — telling them apart would let an anonymous caller enumerate
which tenants exist at which hostnames. So the distinction has to come from the queue in
step 1 and from the tenant's own console, not from the response.

The uniform-`404`-everywhere row is the one that looks least like its cause. That is the
forwarded-host secret, it is an outage rather than a leak, and the log line to alert on is
`tenancy.edge_auth_mismatch`.

## What it costs

Custom domains are billed per domain beyond a plan's included allowance: **2 on Hobby, 15
on Pro, 25 on Scale, then $0.25/month each** (Render's published rates, August 2026 —
confirm before committing to a number).

The wildcard is one domain per environment, so three in total. Everything above that is
one per tenant that takes a custom domain. A hundred white-label tenants on the Scale plan
is 75 chargeable domains, about **$19/month** — small against the ~$150–180/month the
platform already costs, but it grows linearly with exactly the customers the feature is
sold to, so it belongs in the pricing of that plan rather than being absorbed.

Tenants on their platform subdomain cost nothing extra: that is what the wildcard buys.

## Why this is manual

Attaching a domain is an operator step rather than something the verification service does
by itself. Render has an API for it (`POST /services/{serviceId}/custom-domains`), so this
is a decision and not a limitation: nobody has integrated that API here yet, and the
tenant-facing surface is identical either way — the customer waits for "live" regardless of
whether a person or a program moved it there. Automating it later replaces the body of the
activate endpoint and changes nothing a tenant sees.

The cost of the decision is that **a verified domain sits waiting until somebody looks**.
So watch for domains verified more than 24 hours ago with no activation, as a daily digest
rather than a page — nothing here is urgent enough to wake anyone, and a queue nobody
watches is the failure mode this feature actually has.

## Why the blueprint does not declare these

`render.yaml` is the source of truth for every other resource, and it deliberately says
nothing about custom domains. Tenant hostnames are runtime state — created by customers
between commits, eventually numbering hundreds — and do not belong in a file whose value
is being hand-maintained.

The wildcard is a different case: it is stable, one per environment, and would fit the
blueprint's `domains:` field. It is out for a reason that is a risk rather than a
principle. `domains:` is a list, Render's documented rule is that Dashboard configuration
conflicting with the blueprint is overwritten on sync, and whether a partial list prunes
domains added outside it is not documented anywhere we could find. If it prunes, the first
unrelated blueprint sync after custom domains go live drops every white-label customer's
TLS at once, with no failed deploy to point at. An omitted setting is documented as left
alone, so omitting it is the safe side of an unknown.

To settle it and move the wildcard into the blueprint: in the **development** environment,
add `domains: ['*.app.example.com']` to `whatsappcrm-web-dev`, attach a second throwaway
domain through the Dashboard, sync the blueprint, and see whether the throwaway survives.
If it does, the wildcard can move in; tenant domains still cannot.

## Open

- **Apex custom domains** (`acme.com` rather than `support.acme.com`) are refused. Support
  needs three things: a Public Suffix List lookup to tell an apex from a subdomain
  reliably — `acme.co.uk` is apex and has three labels — a `PLATFORM_EDGE_IPV4` value for
  the `A` record, and a plan for re-publishing that address to every tenant's zone if it
  ever changes. Raised against TAR-416 rather than decided here, because refusing apex is a
  product limit and not an infrastructure one.
- **Periodic re-verification** is deliberately not built. A tenant that repoints DNS away
  after verification leaves a stale verified row; nothing breaks, and re-checking on a
  schedule would let one DNS blip un-verify a live domain, which is worse.
