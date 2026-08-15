# Clear tickets nobody could take

**Who this is for:** supervisors and admins. No technical knowledge is assumed. If you are
building against the API, read [the auto-assignment reference](../reference/auto-assignment.md)
instead.

When a customer writes in, your workspace opens a ticket and gives it to an agent
automatically. If it cannot find anyone who is free to take it, it does not guess — it leaves
the ticket unassigned and puts it under **Flagged for you**, where you can see it and place
it yourself.

This guide covers reading that list and clearing it. For deciding where new tickets go in the
first place, read
[Route new tickets to the right team](route-new-tickets-with-rules.md).

## Before you start

- You are signed in to your workspace as a supervisor or an admin. Agents do not see this
  list and cannot assign tickets.
- You know which of your agents are working. The list tells you _why_ nobody was found, not
  who to pick.

## How a ticket ends up flagged

Auto-assignment looks for an agent who is **all four** of these:

- Their account is active.
- They have set themselves to **Available** — not away or offline.
- They have used the workspace in the last 15 minutes. Somebody who set themselves available
  on Monday and closed their laptop does not count.
- They are under their ticket limit. Every agent may hold 5 active tickets at once unless
  that has been changed.

If a routing rule sent the ticket to a team, only that team's members are considered. If no
rule matched, everyone in the workspace with the agent role is considered — supervisors are
deliberately left out of the rotation, so put yourself in a team if you work a queue.

When nobody passes all four tests, the ticket stays unassigned and is flagged. **Nothing is
lost, and the customer's messages keep arriving normally** — the ticket simply has no owner
until you give it one.

## Find the flagged list

1. Select **Settings** in the left navigation, then **Assignment**. The **Assignment and
   reporting** page opens.
2. **Flagged for you** is at the top of the page.

The section shows how many tickets are flagged. If the list is longer than one page, it says
**Showing the 25 longest-waiting. More are flagged than fit on one page.** instead — assign
some, and the next ones appear.

If nothing is stuck, the section says **Nothing is stuck** and **Every ticket in this
workspace reached an agent.**

Each row shows:

| Column                   | What it tells you                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| **Ticket**               | The subject, or the ticket number when it has none — and which team routing tried, or **Whole workspace** |
| **Why it is unassigned** | Which of the three situations below applies                                                               |
| **Waiting**              | How long the ticket has been flagged                                                                      |
| _(last column)_          | The **Assign** button. It appears only if you may assign                                                  |

**The longest-waiting ticket is at the top.** This list is deliberately not ordered by
priority: a customer who has been waiting since yesterday morning comes before an urgent
ticket flagged a minute ago.

## What each reason means, and what to do about it

Select a reason above the list to see only those tickets. Select **All reasons** to clear the
filter.

### Everyone at capacity

Every agent who could take this ticket is already holding as many as they are allowed.

This one usually fixes itself as your team closes work. Act on it if the wait is getting
long: assign the ticket to somebody anyway, or ask an agent to close what they have finished.

### Nobody available

Agents exist who could take this ticket, but none of them is available right now — they are
away, offline, or have not used the workspace in the last 15 minutes.

This is a staffing gap. If you believe somebody _is_ working, ask them to check that their
status says **Available** — the workspace only routes to people who have set it.

### No agents to route to

Nobody could ever have taken this ticket. Either the rule that claimed it points at a team
with no members, or your workspace has no agents at all.

This is a configuration problem rather than a busy afternoon. Check the team on the **People**
page, and check the rule that sent the ticket there.

## Assign a flagged ticket

1. Find the ticket in the list and select **Assign**. The **Assign** dialog opens.
2. Under **Assign to**, choose an agent.
3. Select **Assign ticket**.

A message confirms who it went to, and the ticket leaves the flagged list.

**The list of agents is not filtered by availability or by ticket limit**, and that is
deliberate: the reason this ticket is here is that nobody passed those tests, so a filtered
list would be empty exactly when you need it. Picking somebody at their limit is allowed, and
so is picking yourself.

**Auto-assignment will not move the ticket again** once you have assigned it. Your decision
is final as far as the workspace is concerned; you can still reassign it yourself later.

## Things worth knowing

**A flagged ticket is never retried automatically.** If an agent frees up a minute after a
ticket was flagged, that ticket still waits for you. Clearing this list is a real task, not a
formality.

**Assigning does not change the ticket's status or its deadlines.** It stays open, and any
response deadline keeps running from when the customer wrote in. Placing a ticket quickly is
the point.

**A ticket flagged after a rule sent it to a team keeps that team.** You are choosing a person
inside — or outside — that team, not undoing the rule.

**The list is per workspace, not per supervisor.** "Flagged for you" means "for a supervisor
to handle", so a colleague may clear a ticket before you do. If a row disappears while you are
looking at it, somebody else took it.

## Troubleshooting

**The section says "Nobody in this workspace is active enough to take a ticket." when I open
the Assign dialog.**
Your workspace has no active agent accounts to offer. Invite an agent, or activate an existing
account, on the **People** page. This is the same situation as **No agents to route to**, seen
from inside the dialog.

**Tickets keep arriving in this list every morning.**
Either your agents' limits are too low for the volume you receive, or too few of them mark
themselves available early. The reason column tells you which: **Everyone at capacity** points
at the limits, **Nobody available** points at the start of the working day.

> **TODO(author):** the concurrent-ticket limit is 5 per agent and there is no console screen
> for changing it — no endpoint writes that setting yet. Until one ships, a supervisor reading
> this cannot act on a capacity problem except by assigning tickets by hand. Whoever builds
> that surface should replace this note with the steps.

**A ticket is unassigned but is not in this list.**
Not every unassigned ticket is flagged. This list holds only the ones auto-assignment tried
and failed to place. A ticket somebody released by hand, or one whose routing has not run yet,
is unassigned without being stuck.

**Nothing appears here even though tickets are arriving unassigned.**
Ask an admin to check that the platform's background worker is running. When it is not,
tickets are created but nothing routes them at all — so nothing is ever flagged either.
