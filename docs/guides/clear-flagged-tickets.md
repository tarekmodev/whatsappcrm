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
- They are under their ticket limit. Every agent may hold 5 active tickets at once until
  somebody changes it, either for that agent or for the whole workspace — see
  [Raise an agent's ticket limit](#raise-an-agents-ticket-limit).

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

This one usually fixes itself as your team closes work. If the wait is getting long you have
three moves: assign the ticket to somebody anyway, ask an agent to close what they have
finished, or [raise an agent's ticket limit](#raise-an-agents-ticket-limit) so more work reaches
them in future.

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
3. Optionally write a note under **Why this person**. The hint says **Optional. Anything you
   write is recorded on the ticket’s history as the reason for the override.**
4. Select **Assign ticket**.

A message confirms who it went to, and the ticket leaves the flagged list.

**The reason is offered here, not demanded.** A flagged ticket is held by nobody — that is
what put it in this list — so placing it takes work away from no one and there is no handoff
to explain. Clearing this queue is bulk triage, and a mandatory free-text field in front of it
would slow down exactly the task this page exists for. If you do write something, it goes on
the ticket's history.

**It is required when you move a ticket somebody already holds.** That is a different act on a
different screen — [Hand a ticket on, or ask a supervisor](hand-over-or-escalate-a-ticket.md)
covers it — and there the field carries an asterisk and the dialog will not submit without it.

**The list of agents is not filtered by availability or by ticket limit**, and that is
deliberate: the reason this ticket is here is that nobody passed those tests, so a filtered
list would be empty exactly when you need it. Picking somebody at their limit is allowed, and
so is picking yourself.

**Auto-assignment will not move the ticket again** once you have assigned it. Your decision
is final as far as the workspace is concerned; you can still reassign it yourself later.

## Raise an agent's ticket limit

Every agent has a **ticket limit** — the most active tickets auto-assignment will give them at
once. When a ticket is flagged **Everyone at capacity**, that limit is what stood in the way.
You can change it from the flagged list without leaving the page.

**Before you start:** you are a supervisor or an admin. Both roles can change a limit. Agents
cannot change any limit, including their own, and do not see this page at all. If your own
account cannot change limits, you still see the notice described in step 1 — it reads **Ask an
admin or a supervisor to raise an agent’s limit.** and shows no button, so you can still see why
the queue is stuck and who to ask.

1. Find the notice above the list, and select **Change an agent’s limit**. The **Change an
   agent’s limit** dialog opens. The notice appears whenever a ticket on the page is flagged
   **Everyone at capacity**, and counts them — for example **2 of these are waiting because every
   agent is at their limit.** It is offered only on that reason, because a higher limit answers
   nothing when the problem is that nobody is available.
2. Under **Agent**, choose the person whose limit you want to change. Agents already at their
   limit are listed first, and each name shows what they are holding now against the limit that
   applies to them — for example **Liang Wei — 5 of 5 tickets**. The hint under the list says
   **Only this agent’s limit changes. Everyone else keeps theirs.**
3. Read **Current load**. It tells you the agent's current load against the limit that applies to
   them — for example **5 of 5 active tickets** — and, on the line under that reading, whether the
   limit is one set for them or the workspace default they inherit.
4. Under **Ticket limit**, type the new number. It must be a whole number between 1 and 1000.
   To hand the agent back to the workspace default instead, select **Use the workspace default
   (5)** — the number in that label is your workspace's own default, not always 5. Ticking that
   box disables the **Ticket limit** field and shows the default in it. Clear the box to type a
   number again: an agent who already inherits the default opens with the box ticked, so clearing
   it is the only way to reach the field.
5. Select **Save limit**.

A message confirms the new limit — for example **Liang Wei’s limit is now 8**. If you handed the
agent back to the workspace default, it reads **Liang Wei now uses the workspace default of 5**
instead.

**The flagged ticket in front of you does not move.** A higher limit frees that agent for the
_next_ ticket auto-assignment routes; nothing re-routes a ticket that has already been flagged.
Assign the one on screen when you are ready.

**The change applies everywhere, not just to this ticket.** You are changing that agent's limit
across the whole workspace, and it takes effect on the very next ticket the workspace routes —
there is nothing to save elsewhere and nothing to restart.

**Lowering a limit takes no ticket away from anybody.** An agent already holding more than the
new number keeps all of them; they simply stop receiving new ones until they are back under it.
The dialog warns you before you save.

**The agent list holds one page.** In a workspace with many agents you may not see everyone. The
hint under **Agent** says so when that happens.

## Things worth knowing

**A flagged ticket is never retried automatically.** If an agent frees up a minute after a
ticket was flagged, that ticket still waits for you. Clearing this list is a real task, not a
formality.

**Assigning does not change the ticket's status or its deadlines.** It stays open, and any
response deadline keeps running from when the customer wrote in. Placing a ticket quickly is
the point.

**A flagged ticket belongs to nobody and to no team.** If a routing rule matched, it placed
the ticket and the ticket never reached this list; only a ticket that rotation could not place
is flagged, and that happens without a team. So the **Ticket** column reads **Whole
workspace** on every row today, and you are choosing a person rather than working inside a
team the rule picked.

**The list is per workspace, not per supervisor.** "Flagged for you" means "for a supervisor
to handle", so a colleague may clear a ticket before you do. If a row disappears while you are
looking at it, somebody else took it.

## Troubleshooting

**The section says "Nobody in this workspace is active enough to take a ticket." when I open
the Assign dialog.**
Your workspace has no active agent accounts to offer. Invite an agent, or activate an existing
account, on the **People** page. This is the same situation as **No agents to route to**, seen
from inside the dialog.

**The notice says "This console cannot read agent limits right now" and shows no button.**
The console could not read your workspace’s assignment settings, so it has no limits to offer
you — this is not a permission problem, and it is not the same as the **Ask an admin or a
supervisor** wording, which means your own account may not change a limit. The tickets on the
list can still be [assigned by hand](#assign-a-flagged-ticket) while it persists. If it does
not clear on a reload, ask an admin to check that the platform is reachable.

**Tickets keep arriving in this list every morning.**
Either your agents' limits are too low for the volume you receive, or too few of them mark
themselves available early. The reason column tells you which: **Everyone at capacity** points
at the limits, **Nobody available** points at the start of the working day. For the first,
[raise the limits of the agents who keep filling up](#raise-an-agents-ticket-limit); for the
second, ask your team to set themselves **Available** when they start.

**A ticket is unassigned but is not in this list.**
Not every unassigned ticket is flagged. This list holds only the ones auto-assignment tried
and failed to place. A ticket somebody released by hand, or one whose routing has not run yet,
is unassigned without being stuck.

**Nothing appears here even though tickets are arriving unassigned.**
Ask an admin to check that the platform's background worker is running. When it is not,
tickets are created but nothing routes them at all — so nothing is ever flagged either.
