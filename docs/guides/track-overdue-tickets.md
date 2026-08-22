# Watch tickets that miss their deadline

**Who this is for:** supervisors and admins, and any agent who wants to know what the **SLA**
column means. No technical knowledge is assumed. If you are building against the API, read
[the SLA timers reference](../reference/sla-timers.md) instead.

Your workspace gives every new ticket a deadline for its first reply. If nobody answers the
customer in time, the ticket is marked **Overdue** in the queue and your supervisors are
told. This guide covers reading those marks and clearing the alerts.

## Before you start

- You are signed in to your workspace.
- Every role sees the **SLA** column and can filter the queue by **Overdue**.
- Only supervisors and admins receive alerts and see the alert bell.

## What the deadline is

Your workspace has one response window that applies to every ticket. The standard setting is
**one hour for the first reply**, counted from the moment the customer's message opened the
ticket.

Two things about that clock are worth knowing before you read a badge:

**Only a person's reply stops it.** An automatic reply does not count. The clock stops when
somebody on your team sends a message.

**The clock runs on real time, not working hours.** A ticket that arrives at 17:30 keeps
counting overnight, so you may find tickets marked Overdue first thing in the morning that
nobody could have answered. That is expected behaviour today, not a fault.

## What each SLA badge means

The **SLA** column appears on the ticket queue and on each ticket.

| Badge       | What it means                                                      |
| ----------- | ------------------------------------------------------------------ |
| **Due**     | The clock is running. The badge shows when the reply is due        |
| **Paused**  | The ticket is **Waiting on customer**, so the clock is not running |
| **Met**     | Somebody replied in time                                           |
| **Overdue** | The deadline passed with no reply. The row is flagged              |
| **No SLA**  | This ticket has no deadline                                        |

**Paused** appears while a ticket is **Waiting on customer**. When the customer writes back,
the clock starts again with the deadline pushed forward by however long you waited — time
spent waiting on them is never counted against you.

**No SLA** is not an error. It appears when your workspace has response deadlines switched
off, or when a ticket was closed before its deadline mattered.

**Overdue never clears.** Replying to an overdue ticket is the right thing to do and it stops
the clock, but the badge stays Overdue. The record of the miss is deliberately not erased by
a late reply — otherwise a week of missed deadlines would look like a clean week.

## See only the overdue tickets

1. Select **Tickets** in the left navigation. The **Ticket queue** opens.
2. Find the **SLA** filter above the table. It offers **All** and **Overdue**.
3. Select **Overdue**.

The list narrows to tickets that missed their deadline. The other filters stay as you had
them, so you can combine **Overdue** with a scope or a priority.

**The filtered view is a link you can send.** The filter is in the page address, so copying
the URL and pasting it to a colleague shows them the same list.

Select **All** to clear the filter.

## Read and clear your alerts

When a ticket goes overdue, every supervisor who should know about it gets an alert. Alerts
appear on the bell in the top bar, on every page.

1. Select the bell. The alert panel opens.
2. Each row shows the ticket number, what was missed — **No first response in time** or
   **Not resolved in time** — who was holding the ticket, and how long ago the deadline
   passed.
3. Select a ticket number to open the ticket and deal with it.
4. Select **Mark seen** to take the alert off your list.

The number on the bell counts alerts you have not marked seen. If there are more than one
page of them it shows **20+**, and the panel says **More alerts are waiting. Open the ticket
queue and filter by Overdue.**

When nothing is waiting, the panel says **Nothing is overdue** and **Tickets that miss their
SLA window appear here, and your team is notified.**

**Marking an alert seen does nothing to the ticket.** It is a read receipt on the
notification. The ticket stays open, stays Overdue, and stays assigned to whoever holds it.

**The bell does not update by itself.** A ticket that goes overdue while you are sitting on a
page does not make the number change in front of you; it appears the next time the page
loads. Nothing is lost — the alert is stored, not just announced.

## Who gets alerted

Alerts go to the supervisors and admins on the ticket's own team — anyone active who shares a
team with the agent holding it.

If nobody shares a team with them, or the ticket has no owner at all, **every** supervisor and
admin in the workspace is alerted instead. A broad alert is better than one that reaches
nobody.

Two consequences worth expecting:

- **You may be alerted about a ticket held by somebody you do not recognise.** That is the
  fallback above doing its job.
- **A supervisor working their own queue is alerted about their own tickets.** That is
  deliberate, not a bug.

Alerts are personal. Marking one seen clears it from your bell only; your colleagues still
have theirs.

## Change the response window

Supervisors and admins can change it themselves. Agents cannot, and do not see the screen.

1. Open **Settings → Response deadlines**.
2. Set **First response, in minutes**. The standard setting is 60 minutes, and the screen
   tells you what it is so you can see whether your workspace has changed it.
3. Set **Resolution, in minutes** if you want a second deadline for closing the ticket. Leave
   it empty for none, which is the standard setting.
4. Use **Give new tickets a deadline** to switch deadlines off for the whole workspace without
   losing the numbers you set.
5. Select **Save changes**.

A window is anything from 1 minute to 43,200 (thirty days). Anything outside that is refused
with the reason shown beside the field.

If your workspace has a window that applies to one priority instead of the default, it is
listed under **Priority overrides** on the same screen. Those are read-only here — ask whoever
operates the platform to change one.

Two things about a change, whenever you make one:

- **It applies to new tickets only.** Tickets already running keep the deadline they were
  given. Shortening the window does not retroactively make yesterday's tickets overdue, and
  lengthening it does not clear ones already marked.
- **Deadlines can be switched off** for the whole workspace. Every ticket then shows **No
  SLA** and no alerts are raised.

## Troubleshooting

**A ticket is marked Overdue but somebody did reply in time.**
Check who sent the reply. Only a message from a person stops the clock — an automatic reply
does not. If a person did answer inside the window, report it: this should not happen, and it
is the one failure this feature treats as more serious than a late alert.

**Tickets go Overdue every morning.**
The clock runs overnight because response deadlines do not follow working hours yet. If your
workspace only answers during office hours, the window is currently measuring hours nobody
was working.

**I am a supervisor and I see no bell.**
The bell appears for supervisors and admins. If your role was changed recently, sign out and
back in.

**The bell shows a number but the panel is empty.**
Somebody else marked the same alerts seen, or you acknowledged them in another tab. Reload
the page and the count catches up.

**A ticket shows No SLA.**
Either response deadlines are switched off for your workspace, or the ticket was closed
before its deadline applied. Neither is an error.

**Everything went Overdue at once after an outage.**
Deadlines are stored, not counted down in memory, so nothing was lost while the platform was
unavailable — the backlog is worked through when it comes back. The badges are accurate; the
alerts are simply late.
