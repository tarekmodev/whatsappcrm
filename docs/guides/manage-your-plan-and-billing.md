# Choose a plan and manage billing

For a workspace **admin**. Compare the plans, start a paid plan, see how much of your
allowances you have used, and reach your invoices and payment method.

Agents and supervisors cannot see this page. If you open it and read **Your role can see the
plan and its usage, but not change it**, you are signed in as somebody who cannot buy — ask
an admin in your workspace.

> ⚠️ **Nothing can be paid for yet.** The plans, the checkout and the usage meters are all
> built, and the payment provider is not connected in any environment. Choosing a plan today
> opens a stand-in checkout page rather than a real one, and no card is ever asked for or
> charged. Everything else on this page — your seat limit, your conversation allowance, the
> warnings, and what happens when a payment fails — is real and already applies to your
> workspace. This note is removed by the release that connects the provider.

## Before you start

- You are an admin in the workspace.
- You know how many people you want working in the shared inbox. That number is what you are
  billed for.

## Find your plan and usage

1. Select **Settings** in the left navigation.
2. Select **Plans and billing**.

The page opens on **Current plan**, and everything below is on the same page: your
allowances, every tier you could move to, and the way through to your invoices.

## What "Current plan" tells you

| Row              | What it means                                                           |
| ---------------- | ----------------------------------------------------------------------- |
| **Plan**         | The tier this workspace is on                                           |
| **Status**       | Whether it is a trial, active, overdue, waiting for payment, or closing |
| **Seats billed** | How many seats you are being charged for                                |
| **Price**        | The price **per seat, per month** — not the total                       |
| **Renews**       | When the next period starts, and when your allowances reset             |

If you have never bought a plan you see **No paid plan yet** instead, with the line **This
workspace is running on its trial allowances. Choose a plan below when you are ready —
nothing is charged until you do.** That is the normal state of a new workspace, not a
problem.

**A price is per seat.** A five-seat workspace is billed five times the price shown, every
month.

## Agent seats

**Agent seats** shows how many of your plan's seats are in use, as **_n_ of _n_ seats in
use**.

A seat is taken by:

- every agent, supervisor and admin in the workspace, **including anyone suspended**;
- **every invitation you have sent that nobody has accepted yet.**

Both catch people out, and the panel names the second: **_n_ invitations are outstanding and
count against the cap**. A seat is held the moment it is offered, because otherwise you would
invite past your limit and the refusal would land on the person you invited. A suspended
person keeps their seat too — otherwise a workspace could park staff to stay under its limit.

**When every seat is taken, inviting somebody is refused rather than queued.** The refusal
says how many seats you have and what to do: remove a member, withdraw a pending invitation,
or move to a larger plan.

To free a seat, go to **Settings → People** and either remove an agent or withdraw a pending
invitation.

**Adding a seat takes effect immediately and is charged from the day you add it.** Removing
somebody does not reduce your bill until the period you have already paid for ends — you keep
the seat until then, so re-filling it in the same period costs nothing extra.

## Conversations this period

**Conversations this period** counts the conversations your customers have opened with you
inside the current billing period, against your plan's allowance — **_n_ of _n_
conversations**.

**Your customers' messages are never blocked.** Whatever the counter says, an incoming
message is accepted and stored. What an allowance protects is not your inbox, it is the cost
of replying.

Two banners appear as you approach it:

| Banner                                           | When                    | What has changed                               |
| ------------------------------------------------ | ----------------------- | ---------------------------------------------- |
| **You are close to your conversation allowance** | At 80% of the allowance | Nothing. It is notice, while you can act on it |
| **You have used your conversation allowance**    | At the allowance        | See below                                      |

Every admin in the workspace is emailed at both points, and the email says which of the two
behaviours below your platform is set to.

**At the allowance, one of two things happens**, and which one is a setting your platform
operator chooses for the whole platform rather than something you control:

- **Warn.** Everything keeps working. You are told, and your team carries on replying. This
  is the default.
- **Block.** Your customers' messages still arrive and are still stored, and your team cannot
  send replies until the period rolls over or you move to a larger plan.

Your allowance resets when your billing period does, which is the **Renews** date on
**Current plan**.

## Move to a different plan

1. Scroll to **Plans**. Every tier shows its **Allowances** — agent seats and conversations
   per period — and what it **Includes**.
2. Select **Choose _plan name_** on the tier you want.
3. You are taken to the payment provider's own checkout page. Card details are entered there
   and never reach this product.
4. Pay, and you are returned to **Plans and billing**.

**What you see when you come back:**

- **Your plan is active** — the change is done, and the new allowances apply from now.
- **Confirming your payment** — your payment went through and the provider has not confirmed
  it to us yet. This usually takes a few seconds. Select **Refresh**.
- **Checkout cancelled** — nothing was charged and your plan has not changed.

The middle one is not an error. Your payment and the provider's confirmation are two
separate things, and this page will not tell you a plan is active until it actually is.

### A plan you cannot choose

A tier whose limits are **below what you are already using** shows **Not available yet**
instead of a button, and says which limit blocks it:

- **This plan has fewer seats than you are using. Remove an agent or withdraw an invitation
  first.**
- **You have already had more conversations this period than this plan allows.**

This is deliberate. Moving down to a plan you are already over would take your money and then
refuse your next invitation, so it is refused before you pay rather than after.

For the conversation one, waiting for your period to roll over is usually the answer — the
count resets and the tier becomes selectable.

## Invoices, payment method and cancelling

Under **Invoices and payment**, select **Open the billing portal**.

That is the payment provider's own portal, opened signed in as this workspace, and it is
where all four of these live:

- past invoices and receipts;
- the card or payment method on file;
- changing your plan;
- cancelling.

**The button appears once you are on a paid plan.** Before that you see **The billing portal
opens once this workspace is on a paid plan. Choose one below to get started.**

The link is generated fresh each time you select it and is short-lived, so bookmarking it
will not work — come back to this page.

### If you cancel

**Cancelling does not switch anything off.** You have paid through the end of the current
period and your workspace works normally until then. A banner appears on **Plans and
billing** — **This plan is set to close**, with the date under **Closes**.

To keep the plan, reopen the billing portal and undo the cancellation. The banner disappears.

## If a payment fails

**A failed payment is not an outage.** Your status changes to **Payment overdue** and a
banner appears, and your team keeps working exactly as before.

The provider retries the charge over the following three weeks. Any successful retry clears
it and your status goes back to **Active**.

**If nothing is collected in those three weeks, the workspace is suspended.** Then:

- your agents cannot sign in, and anyone signed in loses access on their next action;
- your customers' messages still arrive and are still stored — nothing is dropped and nobody
  is bounced — but you cannot see or answer them while the workspace is suspended;
- **nothing is deleted.** Every conversation, contact, ticket and setting stays where it is.

**You can still reach Plans and billing while suspended**, and only you — an admin. That is
on purpose: a workspace that could not reach checkout could not pay its way out.

Settle the payment and access is restored with everything intact. Messages that arrived
_during_ the suspension do not reappear on their own; ask your platform contact to bring them
into your inbox when you ask for access back.

## Troubleshooting

**"Your role can see the plan and its usage, but not change it."** You are signed in as an
agent or a supervisor. Plans and billing are changed by admins.

**"We could not open the checkout page. Try again in a moment."** The payment provider could
not be reached, or the tier you picked is not fully set up on the provider's side. Try again;
if it keeps happening, it is a platform problem rather than something you can fix — contact
support.

**"We could not open the billing portal. Try again in a moment."** The same, for the portal.

**"No plans are available."** No tier is on sale for this workspace right now. Contact
support and they can put one in place.

**An invitation was refused and mentions seats.** Every seat on your plan is taken. Withdraw
an unaccepted invitation or remove an agent under **Settings → People**, then invite again —
or move to a larger tier here.

**A reply was refused and mentions conversations.** Your allowance for this period is spent
and your platform is set to block rather than warn. Incoming messages are still being
received and stored. Move to a plan with a larger allowance, or wait for the period to roll
over.

**The page will not load at all.** Reload it. If it keeps failing, contact support — nothing
about your workspace or your plan has changed, only the page failed.

## What this cannot do yet

- **Nothing can actually be paid for**, in any environment. See the note at the top.
- **You cannot cancel, change your plan, or download an invoice from this product.** All four
  are in the payment provider's portal, which this page links to.
- **A tier's features are shown, not enforced.** **Includes** tells you what a tier was sold
  with; today nothing stops a workspace using a feature its tier does not list.
- **The conversation policy is not yours to set.** Whether reaching your allowance warns or
  blocks is a platform-wide setting your operator controls.
- **Reactivating a suspended workspace is not self-service.** There is no button for it here;
  contact support.

---

Engineers building against the same surface want
[the billing API reference](../reference/billing-api.md). The wider setup checklist, workspace
statuses and what suspension means for your team are in
[Set up your workspace](set-up-your-workspace.md).
