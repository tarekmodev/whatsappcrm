# Change a ticket's status and priority

**Who this is for:** agents and supervisors working tickets in the console. No technical
knowledge is assumed. If you are building against the API, read
[the tickets API reference](../reference/tickets-api.md) instead.

A ticket is one piece of work for one customer. It opens by itself when a customer writes
in, and it stays in your queue until you resolve or close it. This guide covers moving a
ticket through those states and changing how urgently it is treated.

## Before you start

- You are signed in to your workspace.
- The ticket is assigned to you or to one of your teams. Tickets nobody has been given are
  visible to supervisors and admins only.
- Every role can change a ticket's status and priority. If yours has had that taken away,
  the ticket page says so instead of showing the controls.

## What the four statuses mean

| Status                  | What it means                                                     |
| ----------------------- | ----------------------------------------------------------------- |
| **Open**                | Live work. The customer is waiting on you                         |
| **Waiting on customer** | You have replied and need something back before you can continue  |
| **Resolved**            | You finished the work. The resolution time is recorded            |
| **Closed**              | Filed without a resolution — a wrong number, spam, or a duplicate |

**Resolved and Closed are final.** Neither can be moved back, and there is no undo. If the
customer writes again after you resolve a ticket, a new ticket opens for them and nothing
is lost.

## Find a ticket

1. Select **Tickets** in the left navigation. The **Ticket queue** opens.
2. The queue shows your own and your teams' active work — everything that is **Open** or
   **Waiting on customer**. Resolved and closed tickets are not in it.
3. Narrow the list with the **Status**, **Priority** and **Scope** filters above the table.
   **Scope** offers **Assigned to me**, **Unassigned** and **All tickets**; the wider two
   are available to supervisors and admins.
4. Select a ticket to open it. **Back to the queue** returns you to the list.

A ticket with no subject shows as **Ticket #** and its number. That is normal: a ticket
opened by a customer's first message has nothing to take a subject from, and the number is
what you and the customer quote anyway.

### Why a ticket is where it is in the list

The queue is ordered for you and has no sort control. **Urgent tickets come first, then the
most recently opened.** Within one priority band, the newest ticket is at the top.

## Change a status

1. Open the ticket.
2. Find **Status and priority**.
3. Select the move you want. Only the moves the ticket can make are shown:
   - **Waiting on customer** — you are blocked until they reply.
   - **Move back to open** — you are working it again.
   - **Resolve** — the work is done.
   - **Close** — file it without a resolution.
4. **Resolve** and **Close** ask you to confirm, because neither can be undone. Select
   **Resolve ticket** or **Close ticket** in the dialog to go ahead.

A message confirms the new status, and the ticket updates on screen. If you resolved or
closed it, it also leaves the queue and disappears from the conversation's side panel.

When a ticket is closed, the buttons are replaced by **This ticket is closed. Its status
cannot change.**

## Change a priority

1. Open the ticket.
2. Under **Status and priority**, select a new value in the **Priority** list: **Low**,
   **Normal**, **High** or **Urgent**.

The change applies straight away — there is no confirmation, and you can change it back.
Setting a ticket to **Urgent** moves it to the top of the queue for everybody who can see
it.

## Tickets that reopen by themselves

**A customer replying to a ticket you set to Waiting on customer reopens it to Open.** You
do nothing, and nobody has to notice the reply for it to happen.

Two things follow:

- The ticket comes back into your queue on its own. The history shows **Reopened — customer
  replied** rather than naming an agent, because no agent did it.
- It can take a moment. The reopen happens just after the message arrives, not at the same
  instant. Reload the page if you are watching for it.

This applies to **Waiting on customer** only. A customer who writes back after you resolved
or closed their ticket gets a **new** ticket instead.

## Troubleshooting

**"This ticket is no longer pending — somebody or something changed it while you were
working. Reload it and try again."**
The customer replied while you were resolving the ticket, and it reopened underneath you.
The page reloads itself; read the new message before deciding again. This is deliberate —
resolving anyway would hide the fact that they just wrote.

**"A resolved ticket cannot be moved to open."**
Resolved and closed are final. If the customer needs more help, wait for their next message
— it opens a new ticket — or open the conversation and work from there.

**"Your role can change this ticket's priority but not resolve or close it. Ask a supervisor
to finish it."**
Your role can triage but not finish work. A supervisor or admin can resolve it.

**"Your role can read this ticket but not change it. Ask a workspace admin."**
Your role has read-only access to tickets. An admin can change that.

**"This ticket is not available to you"**
The ticket is outside what your role can see, or it no longer exists. A link shared by a
supervisor can land here. Go back to the queue and pick another.

**"Nothing matches this filter. Try a wider scope, status or priority."**
Your filters exclude everything. Set **Scope** to **All tickets** and clear the others, if
your role allows it.

**A ticket shows "Closed without a resolution".**
It was closed without being resolved first, so it carries no resolution time. That is
correct for spam and wrong numbers, and reporting depends on the distinction. To record a
resolution time, resolve a ticket before closing it.
