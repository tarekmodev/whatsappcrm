# Hand a ticket on, or ask a supervisor

**Who this is for:** agents, supervisors and admins working in the console. No technical
knowledge is assumed. If you are building against the API, read
[the tickets API reference](../reference/tickets-api.md) instead.

Sometimes a ticket is not yours to finish. Either somebody else should take it over, or you
should keep it and get a decision from a supervisor. The console has one card for both, and
whichever you choose, your reason is written into the ticket's history where the next person
will read it.

## Before you start

- You are signed in to your workspace and looking at a ticket.
- Every role can hand a ticket on and escalate one. If your role has had those rights removed,
  the card says **Your role can read this ticket but not hand it on or escalate it. Ask a
  workspace admin.**
- A reason is required, and it must be at least three characters. This is not a formality: it
  is the only thing that tells the next person what is left to do.

## Which one do you want

| You want                                          | Use          | What happens to the ticket |
| ------------------------------------------------- | ------------ | -------------------------- |
| Somebody else to take this over                   | **Reassign** | It leaves you              |
| A supervisor to decide something, but you keep it | **Escalate** | It stays with you          |

**Escalating does not give the ticket away.** This is the thing people get wrong. You stay
responsible for the customer while the supervisor looks. That is deliberate — if escalating
handed the ticket over, a customer writing in at two in the morning would be left with nobody
until a supervisor woke up.

Both are on the **Handoff** card on the ticket, under the heading **Handoff**, which reads
**Hand this ticket to a teammate, or ask a supervisor to look at it. Both are recorded in its
history.**

## Hand a ticket to a teammate

1. Open the ticket and find the **Handoff** card.
2. Select **Reassign**. The **Reassign** dialog opens, headed with the ticket's subject.
3. Select a name under **Hand it to**. The list shows **People you share a team with, plus
   anyone your role can assign to.**
4. Write your reason under **Why you are handing it on**. Say what is left to do — the next
   person reads this before anything else.
5. Select **Reassign ticket**.

A message confirms the ticket is now with the person you chose, and the ticket leaves your
queue.

**You can only hand on a ticket that is assigned to you**, and only to somebody you share a
team with. That is what stops work being moved off a colleague mid-way through, or parked on a
team that knows nothing about it. Supervisors and admins are not bound by this and can place
any ticket anywhere.

**You cannot hand a ticket back to nobody.** Leaving it unassigned is not a handoff — it is
abandonment, and the ticket would sit in a queue with no owner. If nobody on your team can take
it, escalate instead and say so.

### If the list of people is empty

The dialog says **You share no team with anyone who could take this. Ask a supervisor to
reassign it.** That is the rule above, seen from inside the dialog — a supervisor can place the
ticket anywhere and you cannot.

## Ask a supervisor to look at a ticket

1. Open the ticket and find the **Handoff** card.
2. Select **Escalate**. The dialog opens and reminds you: **You keep this ticket. A supervisor
   is asked to look at it, and your reason goes on its history.**
3. Leave **Ask someone in particular** set to **Whoever is covering this ticket** unless you
   need a specific person. The default reaches more people and is more likely to find somebody
   who is working.
4. Write your reason under **What you need decided**. Say what is stuck and what would unblock
   it, and include a deadline if there is one.
5. Select **Escalate ticket**.

A message confirms how many people were told.

**Escalating twice is allowed and is sometimes right.** If the first ask went unanswered, ask
again. Nothing suppresses a second escalation, because the situation where you most need the
button to work is the one where the first ask was ignored.

### Who gets told

If you leave the default, the escalation goes to the supervisors and admins on the ticket's own
team — anyone active who shares a team with whoever holds it. If nobody shares a team with
them, **every** supervisor and admin in the workspace is told instead. A broad ask is better
than one that reaches nobody.

If you name somebody under **Ask someone in particular**, only that person is told. You can
only name someone who is already allowed to read the ticket.

### "Recorded, but nobody was notified"

If your workspace has no active supervisor or admin, the message reads **… is recorded as
escalated, but nobody in this workspace is set up to receive it. Ask a workspace admin.**

**This is not a failure, and it is not something you did wrong.** The escalation is on the
ticket's history and will be seen by anyone who opens it. What is missing is somebody to send
it to, and only an admin can fix that — by giving somebody the supervisor or admin role.

## Read a ticket's history

Every handoff and escalation is recorded, along with status changes and everything else that
has happened to the ticket.

1. Open the ticket.
2. Find the **History** section: **Everything that has happened to this ticket, newest first.**

Each entry says what happened, who did it, and — for a handoff or an escalation — the reason
they gave, under **Reason**.

| Entry                                  | What it means                                             |
| -------------------------------------- | --------------------------------------------------------- |
| **Ticket opened**                      | The customer wrote in and the ticket was created          |
| **Handed on**                          | Somebody reassigned it. The entry names who to and from   |
| **Released**                           | It was put back with nobody holding it                    |
| **Escalated**                          | Somebody asked for a supervisor                           |
| **Status changed**                     | For example, from Open to Waiting on customer             |
| **Priority changed**                   | Somebody re-prioritised it                                |
| **Reopened — customer replied**        | The customer wrote back and the ticket reopened by itself |
| **Auto-assignment could not place it** | Nothing matched, so it was left for a supervisor          |
| **SLA missed**                         | The reply deadline passed                                 |

An escalation reads **to whoever is covering this ticket** when you left the default, and names
a person when you chose one.

**The history shows one page.** Older entries are not shown, and the section says so rather
than pretending the list is complete.

**Nothing is ever removed from the history.** A handoff you made by mistake stays visible, and
so does an escalation you later resolved. The record is what makes the trail worth reading — if
entries could disappear, none of them could be relied on.

## If you are a supervisor being escalated to

> **TODO(author):** there is **no screen for this yet.** Escalations are delivered and stored,
> and a supervisor can see them by opening the ticket and reading its **History** — but there
> is no escalation list, no bell entry and no "mark seen" control in the console, and an
> escalation arriving while you sit on a page does not announce itself. The SLA bell described
> in [Watch tickets that miss their deadline](track-overdue-tickets.md) covers overdue tickets
> only, not escalations. Until that surface ships, agents who escalate should expect to tell a
> supervisor by another route as well. Whoever builds it should replace this section with the
> steps and drop the note from
> [the tickets API reference](../reference/tickets-api.md#limits-and-known-gaps).

## Troubleshooting

**The Reassign button refuses my submission until I write something.**
That is the reason field. It is required whenever somebody already holds the ticket, and three
characters is the minimum. A reason of spaces is refused too.

**I was asked for a reason on a ticket nobody was holding.**
A ticket routed to a team counts as held even when no individual name is on it, so the reason
is asked for. This is under review and may change.

**"You can only hand on a ticket that is assigned to you."**
The ticket is a colleague's, or it sits with a team rather than with you. Ask a supervisor to
move it, or escalate and explain.

**"You can only hand a ticket to a teammate or to one of your own teams."**
The person you chose is not on any team you belong to. Pick somebody from the list, or ask a
supervisor to place it.

**I escalated and nobody replied.**
Escalate again and say it is the second ask. Nothing stops you, and the second entry is on the
history alongside the first.

**I escalated and the ticket is still assigned to me.**
That is correct. Escalating asks for attention; it does not hand the ticket over. If you want
somebody else to take it, use **Reassign**.

**A ticket I could see yesterday is gone.**
Handing a ticket to somebody outside your teams takes it out of your view. It is not deleted —
it is with them, and the history records that you handed it on.
