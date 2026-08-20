# Read the performance dashboard

**Who this is for:** supervisors and admins who need to know how the team is doing, and any
agent who wants to understand their own figures. No technical knowledge is assumed. If you
are building against the API, read
[the reporting dashboard and export reference](../reference/reporting-api.md) instead.

**Performance** shows how quickly your team answers and resolves tickets over a date range
you choose, broken down by agent. This guide covers reading those figures and taking them
away as a spreadsheet.

## Before you start

- You are signed in to your workspace.
- Every role can open **Reports** from the left-hand navigation. The page itself is headed
  **Performance**.
- Supervisors and admins see the whole workspace. Agents see their own and their teams'
  tickets, and only their own row in the breakdown.

## Choose a date range

**The page opens on the last 30 days.** That is a starting point, not a period you asked
for — so before you quote any figure from this screen, read the range line above it and
confirm it covers what you mean.

1. Open **Reports** from the navigation.
2. Under **Date range**, set **From** and **To**, or pick one of the **Quick ranges** —
   **Last 7 days**, **Last 30 days** or **Last 90 days**.
3. Select **Apply range**.

The line above the figures always names what is on screen: _1 Aug 2026 to 16 Aug 2026, in
your workspace's time zone_. It updates with the range, so it is the one place to check
before you copy a number into a report.

**Dates are your workspace's dates.** If your workspace is set to Riyadh time, "1 August" runs
from midnight in Riyadh — not midnight UTC, and not midnight where you happen to be. Everyone
in your workspace sees the same day boundaries.

**The longest range is 366 days.** Ask for more and the screen tells you to pick a shorter
one.

## What each figure means

The **Overview** shows four figures for the range you picked.

| Figure                  | What it counts                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------- |
| **Tickets opened**      | Tickets opened in this range, whatever happened to them since                         |
| **Tickets resolved**    | Tickets resolved in this range, whenever they were opened                             |
| **Closed unresolved**   | Closed in this range without ever being resolved — spam, wrong numbers, duplicates    |
| **First response time** | Median, from the ticket opening to the first reply, for replies sent in this range    |
| **Resolution time**     | Median, from the ticket opening to its resolution, for tickets resolved in this range |

Each duration card also shows an **Average**, a **90th percentile**, and **Tickets measured** —
how many tickets the figure was worked out from. Check that last one before you quote a
number: a 90th percentile worked out from two tickets _is_ one of those two tickets.

**The headline duration is the median**, not the average. The median is the middle value, so
one ticket that sat over a bank holiday weekend does not drag the whole figure with it.

### Opened and resolved do not have to match

A ticket opened in January and resolved in March counts in January's **Tickets opened** and
in March's **Tickets resolved**. Those two figures are counting different things on purpose:
one is work arriving, the other is work finishing. Comparing them tells you whether the team
is keeping up.

This also means the figures for one range do not add up to each other, and they are not
supposed to.

### Durations include nights and weekends

The clock runs on real time. A ticket that arrives at 17:30 and is answered at 08:30 the next
morning shows a 15-hour first response time, even if nobody was meant to be working.

Expect that to inflate your figures for any range covering evenings, weekends or holidays.
Working-hours reporting is not available today. If you are reporting to a client against
agreed business hours, work the figure out separately — do not quote this one.

### "No data" is not zero

A figure reads **No data** when nothing was measured. A week in which nothing was answered
shows **No data**, not `0s` — otherwise a quiet week would look like your fastest one.

## Read the per-agent breakdown

**By agent** shows one row per person, with **Resolved**, **First response (median)** and
**Resolution (median)**.

**Every agent appears, even with nothing in the range.** A row of **No data** means that
person resolved nothing between those dates — that is an answer, not a loading problem.

Three things about this table surprise people:

**Work is credited to whoever did it, not to whoever holds the ticket now.** If Priya answered
a ticket in January and it was passed to Omar in March, the January response time stays on
Priya's row. Reassigning a ticket never rewrites a past month's figures.

**"Not recorded" is a real row.** It covers work whose agent was never recorded — usually
tickets from before the workspace started tracking who answered. It is shown rather than
hidden so the table adds up to the Overview above it.

**"No longer active"** marks someone suspended or removed who still has work in the range.
Their figures stay so a closed period keeps its numbers.

**The Overview figures are not the column averaged.** The note under the table says so:
medians do not add up across rows. Do not work out a team median by averaging the column —
the Overview already has the right number, worked out over every ticket.

## See the day-by-day picture

**Daily volume** charts **Opened** against **Resolved**, one bar per day in your workspace's
time zone. Every day in the range appears, including days with nothing on them.

## Export the report

1. Set the range and scope you want to report on, and check the figures on screen.
2. Select **Export CSV**.
3. The file lands in your downloads folder as `report-agents-2026-08-01-2026-08-16.csv`.

**The file always matches the screen.** It covers exactly the range and scope shown on the
page — there is no separate set of options on the export, so you cannot download a report for
a period you were not looking at. Change the range on screen first, then export.

The spreadsheet holds one row per agent and a final **total** row that is the Overview.

**Durations in the file are in seconds**, not "2h 14m". A spreadsheet can add up, average and
chart a number; it cannot do any of that with text. Divide by 60 for minutes, or by 3600 for
hours.

**Empty cells mean nothing was measured** — the same as **No data** on screen. Leave them
empty: a spreadsheet correctly ignores an empty cell when averaging, and typing `0` in would
drag the average down.

**The file opens in Arabic and other non-Latin scripts correctly** in Excel, Numbers and
Google Sheets, with no import dialogue.

## What agents see

An agent opening Performance — including from a link a supervisor shared — gets a working
dashboard, not an error. The screen says so: _You are seeing your own and your teams'
tickets, and the breakdown shows your row only._

The Overview and Daily volume cover every ticket that agent can see. **By agent** shows their
row alone, because a table of their colleagues' response times is a comparison the workspace
does not put in front of them.

**This is decided by your account, not by the Scope control.** Setting **Scope** to
**Assigned to me** narrows which tickets are counted; it never changes how many rows the
breakdown has. If you expect to see your colleagues and do not, your account does not have
workspace-wide reporting — ask an admin.

## Troubleshooting

**Every figure says "No data".** Nothing happened in that range. Widen the dates, or check
**Scope** is **All tickets** rather than **Assigned to me**.

**"Nobody has work in this range".** Same cause. Pick a wider range, or a scope covering more
of the workspace.

**The numbers changed since yesterday's export.** Two reasons are normal. Tickets opened
earlier can be resolved today, which moves them into today's **Tickets resolved**. And if
somebody changed the workspace's time zone, day boundaries moved with it, so a range can
report slightly differently either side of that change.

**"That date range cannot be exported."** The range is too long. Pick 366 days or fewer.

**"Your role cannot export this report."** Ask a workspace admin.

**"We could not prepare that report."** Try again in a moment. If a wide range keeps failing,
export it in shorter periods and tell your admin — a report that repeatedly times out is
something the platform team needs to know about.

**A response time looks far too long.** Check whether the ticket arrived outside working
hours. Durations include nights and weekends, and a ticket that arrives at 17:30 carries the
whole night in its figure.
