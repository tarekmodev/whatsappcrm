# Set up your workspace

**Who this is for:** the admin of a new workspace. No technical knowledge is assumed. If you are
building against the API, read [the tenant lifecycle reference](../reference/tenant-lifecycle.md)
instead.

A workspace is your organisation on the platform — your WhatsApp numbers, your agents, your
customers and their conversations. This guide covers the three things to set up when it is new,
what your plan limits, and what happens if the workspace is suspended.

Comparing tiers, buying one, and reaching your invoices are a separate page and a separate
guide: [Choose a plan and manage billing](manage-your-plan-and-billing.md).

## Before you start

- You are signed in as an admin. Only admins can change workspace settings; agents and
  supervisors can read some of them and are told so on screen.
- Your workspace exists. It is created either by signing up, or by the team who runs the platform
  provisioning it for you.

## Work through the setup checklist

Select **Getting started** in the left navigation. **Set up your workspace** lists three steps,
and a **Setup progress** meter shows how many are done.

Work through them in any order. Nothing here expires, and you can leave at any point.

### 1. Connect a WhatsApp number

1. Select **Connect WhatsApp** on the first step.
2. Approve the connection in Meta's window when it opens, then come back.
3. The step shows **Done** once a number is connected.

Until a number is connected, no conversation can reach your inbox. This step is first because the
other two are worth little without it — an invited agent has no inbox to work, and branding has
no messages to brand.

### 2. Invite your agents

1. Select **Invite people**. This takes you to **Settings → People**.
2. Select **Invite agent**, enter their email address, and choose a role.
3. They receive an email with their own sign-in and pick their own password.

You can change anyone's role later. The step shows **Done** once you have sent an invitation.

**An invitation you have sent takes a seat straight away**, before the person accepts it. See
[Agent seats](#agent-seats) below.

### 3. Set your branding

Branding puts your own name, logo and colours on the console in place of the default ones.

> The branding editor is not built yet. The step says so on screen and offers **Skip for now**
> instead of a link. Your name and colours are set when the workspace is created until the editor
> arrives.

## Skip a step and come back

1. Select **Skip for now** on any step. It moves to **Skipped later** and stays on the list.
2. To pick it up again, select **Put back on the list**. It returns to **To do**.

A skipped step is a decision you made, not a failure — the checklist counts it as dealt with, so
the progress meter fills. When nothing is outstanding you see **Nothing is outstanding — your
workspace is set up**, above the list rather than instead of it, so anything you skipped is still
there.

**You cannot tick a step yourself.** A step is **Done** because the workspace actually has a
connected number or a sent invitation. That is deliberate: a checklist you could tick by hand
would stop describing your workspace.

## Check your plan and what you have used

Select **Settings** in the left navigation, then **Workspace**. **Plan and usage** shows what
your workspace is entitled to and how much of it is in use.

> ⚠️ **Plan and usage is not connected to live data yet.** The panel and its figures are built,
> and the service that supplies them is not. Treat the numbers as a preview until the release
> notes say otherwise. What is real, and enforced today, is the seat limit and the conversation
> limit described below — you will be told when you reach one.

### Agent seats

**Agent seats** shows how many of your plan's seats are in use, as **_n_ of _n_ seats in use**.

A seat is taken by:

- every agent, supervisor and admin in the workspace, including anyone suspended;
- **every invitation you have sent that nobody has accepted yet.**

The second one catches people out, and the panel names it: **_n_ invitations are outstanding and
count against the cap**. A suspended person keeps their seat too — otherwise a workspace could
park staff to stay under its limit.

When every seat is taken you see **Every seat is taken. Remove an agent before inviting anyone
else**, and inviting somebody is refused rather than queued. If some of those seats are
unaccepted invitations, the message says so, because withdrawing one is the quickest way to free
a seat.

To free a seat, go to **Settings → People** and either remove an agent or withdraw a pending
invitation. To buy more, go to **Settings → Plans and billing** —
[Choose a plan and manage billing](manage-your-plan-and-billing.md) walks through it.

> **TODO(author):** the **People** page says "Invited agents do not use a seat until they
> accept", which is the opposite of what the workspace is enforcing and of what the **Workspace**
> page says. One of the two is wrong. Reported against TAR-409 / TAR-405; this guide describes
> the enforced behaviour.

### Conversations this period

**Conversations this period** counts the conversations customers have opened with you inside the
current period, against your plan's allowance.

**Incoming messages are never blocked.** If the allowance runs out, your customers' messages
still arrive and are still stored — what stops is your team's ability to reply, until the period
rolls over or the limit is raised. You will see a message saying so when a reply is refused.

Whether reaching the allowance actually stops replies, or only warns you, is a platform-wide
setting rather than yours. Both cases, and the emails that warn you first, are covered in
[Choose a plan and manage billing](manage-your-plan-and-billing.md).

**To raise a limit, move to a larger plan** under **Settings → Plans and billing**. That page
also shows your seats and conversations against their allowances, so it is the one to open when
either runs short.

## What each workspace status means

**Plan and usage** shows a **Status** for your workspace. A banner appears at the top of the
console for the three that need your attention.

| Status              | What it means for your team                                   |
| ------------------- | ------------------------------------------------------------- |
| **Trial**           | Everything is available while the trial runs                  |
| **Active**          | Everything is available                                       |
| **Payment overdue** | Everything still works. A payment has not gone through        |
| **Suspended**       | Agents cannot sign in. Nothing has been deleted               |
| **Closing**         | Your team can still work as normal until the workspace closes |
| **Deleted**         | The workspace and its data are gone                           |

**Payment overdue is not an outage.** Your team keeps working exactly as before. The banner is
there so nobody is surprised later: if the payment does not succeed, the workspace is suspended
and agents lose access.

## What suspension means

When a workspace is suspended:

- **Your agents cannot sign in.** Anyone signed in loses access on their next action.
- **An admin can still open Settings → Plans and billing**, and only an admin. A workspace that
  could not reach checkout could not pay its way out of a suspension.
- **Your customers' messages still arrive and are still stored.** Nothing is dropped and nobody
  is bounced. They are held outside your inbox, so you will not see them on screen while the
  workspace is suspended, and you cannot reply until access is restored.
- **Nothing is deleted.** Every conversation, contact, ticket and setting stays exactly where it
  is.

The banner says the same thing: **Agents cannot sign in. Messages your customers send are still
received and stored, and nothing has been deleted.**

## How reactivation works

A suspended workspace comes back with **all of its data intact and nothing to set up again**.
Your agents sign in and find their conversations, tickets and contacts where they left them.

Settle whatever caused the suspension — usually an outstanding payment — and access is restored.

> ⚠️ **Messages sent to you _during_ the suspension do not appear by themselves.** They were kept,
> not lost, but putting them into your inbox is a manual step someone on the platform team has to
> run. Ask for it when you ask for the workspace to be reactivated, and tell your team to expect a
> gap in the thread until it is done.

> **Reactivation is not self-service today.** There is no button in the console for it, and no
> payment screen behind one. Contact support; someone on the platform team restores access.

The same is true of closing a workspace and of deleting it: neither has a control in the console
yet. Both go through support.

## Troubleshooting

**The setup checklist will not load.** You see **We could not load your checklist**. Your
workspace is fine — only the list failed. Reload the page; everything you have already set up is
still set up.

**"Your role can read these details but not change them."** You are signed in as an agent or a
supervisor. Workspace settings are changed by admins. Ask an admin in your workspace.

**An invitation was refused and mentions seats.** Every seat on your plan is taken. Withdraw an
unaccepted invitation or remove an agent under **Settings → People**, then invite again — or move
to a plan with more seats under **Settings → Plans and billing**.

**A reply was refused and mentions conversations.** Your plan's conversation allowance for this
period is spent. Incoming messages are still being received and stored. Move to a plan with a
larger allowance under **Settings → Plans and billing**, or wait for the period to roll over.

**Agents suddenly cannot sign in.** Check **Settings → Workspace**. If the status is
**Suspended**, see [What suspension means](#what-suspension-means). If it is anything else,
report it — it is not a plan or lifecycle problem.
