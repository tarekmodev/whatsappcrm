# Serve the workspace from your own web address

**Who this is for:** workspace admins who can edit their company's DNS records, or who can
ask the person who does. If you are building against the API, read
[the branding and custom domains API reference](../reference/branding-domains-api.md)
instead.

Your workspace already answers on an address the platform issued you, such as
`acme.app.example.com`. This guide adds one of your own — `support.acme.com` — so your team
and anyone you invite reach the console on your company's domain.

To change the logo and colours shown there, see
[Put your own brand on the workspace](brand-your-workspace.md).

## Before you start

- You are signed in as an admin. **Domains** appears in the left navigation only for roles
  that can change it, because control of a domain decides where every invitation and
  password-reset email points.
- You can add DNS records for the domain, or you can get them added. There are two, and both
  are ordinary records any DNS provider supports.
- **Use a subdomain, not a root domain.** `support.acme.com` works; `acme.com` does not,
  and is refused with a message saying so. A root domain cannot be pointed at us with the
  kind of record this uses.

Setting this up takes two DNS changes with a wait in between, then a wait for us. Budget an
afternoon rather than five minutes — most of it is DNS propagation and none of it is work.

## How it works, in four states

Your domain moves through these, and the **Domains** page names the one it is in:

| State             | What is true                                                              |
| ----------------- | ------------------------------------------------------------------------- |
| **Awaiting DNS**  | You have claimed the hostname. We have not seen your ownership record yet |
| **Verified**      | You proved you own it. We are attaching the certificate                   |
| **Live**          | It is serving traffic with a valid certificate                            |
| **Claim expired** | Nobody proved ownership within 7 days, and the hostname has been released |

**Your platform address keeps working the whole time**, and it cannot be removed. That is
deliberate: it is what you still reach the console on while your DNS is propagating, and what
you fall back to if you ever remove your own domain.

## Step 1 — Add the domain

1. Select **Domains** in the left navigation, under Settings.
2. Select **Add a domain**.
3. In **Hostname**, type the address you want, without `https://` — for example
   `support.acme.com`.
4. Select **Add domain**.

A message confirms it, and a card for the new hostname appears with the status **Awaiting
DNS** and the records you need.

## Step 2 — Prove you own it

The card shows **Step 1 — prove you own it** with one record. Add it at your DNS provider
exactly as shown — use the copy buttons rather than retyping.

| Type  | Name                                      | Value                                     |
| ----- | ----------------------------------------- | ----------------------------------------- |
| `TXT` | `_whatsappcrm-challenge.support.acme.com` | `whatsappcrm-domain-verification=<token>` |

Two things to know about the name and the value:

- Many DNS providers want the **name relative to your zone**. If your zone is `acme.com`,
  enter `_whatsappcrm-challenge.support` rather than the full name. If in doubt, enter the
  full name — most providers accept both and strip the duplication.
- The value must be the **whole string**, including the
  `whatsappcrm-domain-verification=` part. A record holding only the token does not pass.

Then, back on the card:

5. Select **Check DNS**.

If we find the record, the status becomes **Verified**. If we do not, the status stays
**Awaiting DNS** and the card says which of these it was — that is not a failure, and DNS
changes routinely take up to an hour to appear.

**You do not have to sit there pressing the button.** We re-check on our own, and the status
updates without you. Come back later.

**The claim lasts 7 days.** The card shows when an unverified claim is released; after that
the hostname goes back to being claimable by anyone, and you would start over.

## Step 3 — Point it at us

Once the domain is **Verified**, the card shows **Step 2 — point it at us** with a second
record.

| Type    | Name               | Value                       |
| ------- | ------------------ | --------------------------- |
| `CNAME` | `support.acme.com` | The value shown on the card |

Add it the same way. Copy the value from the card rather than from anywhere else — it differs
between environments.

If your DNS provider also has an `AAAA` record on that name, remove it. It sends some of your
visitors to an address that does not answer.

## Step 4 — Wait for the certificate

**Verified** does not yet mean reachable. After you verify, we attach the hostname and issue
its HTTPS certificate, and that step is done by our team rather than automatically. The card
says so: _Ownership is proved. We are attaching the certificate — the domain starts serving
traffic once that finishes._

When it is done the status becomes **Live**, and your workspace answers on
`https://support.acme.com`.

This usually completes within a working day. If it has been longer than that, contact
support and quote the hostname.

## Step 5 — Make it the main address

Once a domain is **Live** you can make it the address the platform writes into invitation and
password-reset emails.

1. On the card for that domain, select **Make primary**.

**Primary** appears on the card. Only one domain is primary at a time, and **Make primary**
is offered only once a domain is live — pointing a password-reset link at an address that is
not serving yet would send your team a working email to a page that does not load.

## Remove a domain

1. On the card, select **Remove**.
2. Read the confirmation and select **Remove domain**.

**The console stops answering on that hostname immediately.** Anyone still using it gets an
error until you send them somewhere else. If it was your primary domain, invitation and
password-reset links move back to your platform address in the same moment.

Tidy up afterwards by deleting the `CNAME` and `TXT` records at your DNS provider. Leaving
them costs nothing but they point at a workspace that no longer answers there.

You can have up to **5** custom domains. Your platform address does not count towards that
and cannot be removed.

## Troubleshooting

**"We could not find that TXT record yet. DNS changes can take up to an hour."**
The record is not visible to us. Check it saved at your provider, wait, and check again. If
your provider shows a TTL, that is roughly how long an old answer can linger.

**"A TXT record exists at that name but its value does not match. Check for a typo or an old
record."**
This is the one to look at closely. Usually one of: the value is missing the
`whatsappcrm-domain-verification=` prefix; there is an older record from a previous attempt
still at that name; or the provider wrapped the value in extra quotes. Delete anything stale
and re-add the value exactly as the card shows it.

**"We could not reach that domain's nameservers. We will keep trying." / "The DNS lookup
timed out."**
The problem is between us and your DNS provider, not with your record. We keep re-checking on
our own; nothing is needed from you unless it persists for hours.

**"Wait N seconds before checking this domain again."**
**Check DNS** can be used once every 10 seconds per domain. Every check is a live query to
your nameservers, so it is deliberately paced.

**"support.acme.com is already claimed…"**
Somebody else holds that hostname. If it was an unverified claim of your own that lapsed, it
is released within the hour and you can add it again. Otherwise choose another hostname.

**"acme.com looks like a root domain, and a root domain cannot be pointed at us. Use a
subdomain such as support.acme.com instead."**
Exactly what it says. Pick a subdomain.

**"…is a platform address and cannot be claimed as a custom domain."**
The hostname sits under the platform's own zone, which is not claimable by anyone. Use a
domain your company owns.

**"You can have up to 5 custom domains."**
Remove one you are no longer using before adding another.

**"Custom domains are not available in this environment."**
Custom domains are not configured on the deployment you are signed in to. Contact support.

**"Your workspace address cannot be removed — it is how you always reach the console."**
The platform address is your fallback and is never removable. This is what stops a workspace
becoming unreachable.

**The domain is Live, but the browser shows a security warning.**
The certificate has not finished issuing, or the `CNAME` was changed after it did. Contact
support with the hostname.

**The domain loads, but it says the workspace was not found.**
The hostname is reaching us but is not resolving to your workspace — most often the domain
was removed here while the DNS record is still in place, or the record points at the wrong
environment. Check the **Domains** page still lists it, and contact support if it does.
