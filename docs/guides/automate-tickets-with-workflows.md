# Automate what happens to a ticket

**Who this is for:** supervisors and admins who want a ticket tagged, reassigned, escalated
or re-prioritised without watching the queue for it. No technical knowledge is assumed. If
you are building against the API, read
[the workflow automation API reference](../reference/workflows-api.md) instead.

A **workflow** is a standing instruction with three parts: _when this happens_ (the
trigger), _and the ticket looks like this_ (the conditions), _do this to it_ (the actions).
"When a ticket has been unresolved for four hours, and it is still open, tag it `escalated`
and tell the supervisors" is one workflow.

Workflows are not routing rules. A routing rule decides **where a new conversation goes**,
and the first rule that matches wins. A workflow **changes a ticket that already exists**,
and **every workflow that matches runs**. If you need both, you write both — they are on
different pages and they do not interfere.

## Before you start

- You are signed in to your workspace as a supervisor or an admin. Agents cannot see or
  change workflows.
- The teams, agents and tags you want to use already exist. You choose from what is there;
  you cannot create a tag or a team while writing a workflow. Create teams and check agents
  on the **People** page.
- If you plan to use a business-hours condition, the workspace's business hours are already
  set. Until they are, that condition never matches — see [Troubleshooting](#troubleshooting).

## How a workflow decides

Every workflow goes through the same three steps, every time.

1. **Its trigger has to happen.** A workflow with the trigger **A ticket is created** never
   looks at a ticket that already existed.
2. **Every one of its conditions has to hold.** Conditions combine with "and". There is no
   "or" — to express one, write a second workflow.
3. **Its actions run in the order you listed them.** If one fails, the ones after it are
   skipped, and the history says which one stopped it.

Four things worth knowing before you write your first one:

- **Every matching workflow runs.** Order decides who goes first, not who wins. Two
  workflows that both set a status on the same ticket will both run, and the later one is
  the status you end up with.
- **A new workflow starts switched off.** Nothing happens until you turn it on, which is
  deliberate: a workflow writes to real tickets.
- **A workflow with no conditions runs every time its trigger fires.** That is a legitimate
  thing to write, and unlike a routing rule it cannot swallow anything, because the other
  workflows still run.
- **A workflow acts once per thing that happened.** A ticket that stays unresolved for a
  week escalates once, not once a minute.

## Find your workflows

1. Select **Settings** in the left navigation, then **Workflows**. The **Workflows** page
   opens.
2. The list shows every workflow in the workspace, in the order they run. Each one shows a
   badge reading **On** or **Off**, and three lines: **Runs when**, **And only when** and
   **Then**.

A workflow with no conditions shows _every time — this workflow has no conditions_ under
**And only when**.

## Add a workflow

1. Select **Add workflow**. The **Add a workflow** panel opens.
2. Enter a **Workflow name**. It appears in the run history as the reason a ticket changed,
   so name it after what it does — "Escalate stale tickets", not "Rule 3". Two workflows
   cannot share a name, and capitalisation does not make them different.
3. Under **Trigger**, choose from **Run when**. See [Triggers](#triggers) below.
4. Under **Conditions**, select **Add condition** for each check you want. See
   [Conditions](#conditions).
5. Under **Actions**, select **Add action** for each thing that should happen. At least one
   is required. See [Actions](#actions).
6. Select **Add workflow**.

The workflow appears at the bottom of the list, switched **Off**. Test it before you turn it
on.

### Triggers

Choose exactly one.

| **Run when**                       | Happens when                                                               |
| ---------------------------------- | -------------------------------------------------------------------------- |
| A ticket is created                | A ticket opens, whether from a customer's first message or created by hand |
| A ticket's status changes          | Anybody — or the system — moves the ticket to another status               |
| A ticket is assigned or unassigned | The ticket changes hands, or its owner is cleared                          |
| A ticket misses its SLA            | One of the ticket's SLA deadlines is missed                                |
| A ticket stays unresolved          | The ticket has been open for the number of minutes you set                 |

**A ticket stays unresolved** is the only trigger that asks for a number. Under **After**,
enter the minutes — between 5 minutes and 43 200 minutes (30 days). Four hours is `240`.

Two things about it that the other triggers do not share:

- **It can be up to a minute late.** The workspace checks for overdue tickets about once a
  minute, so a four-hour rule fires between four hours and four hours and a minute after the
  ticket opened. Against a four-hour threshold that is under half a percent.
- **It fires once per ticket, ever.** A ticket that crosses your threshold escalates once.
  It does not escalate again later, even if it stays open for a week, and it does not
  escalate a second time if you edit the workflow.

You can have at most 10 workflows using this trigger. It is a lower limit than the others
because each one is work the workspace does every minute.

### Conditions

A ticket has to match **every** condition. Leave the section empty to run every time the
trigger fires.

| **Check**             | Matches on                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| Ticket status         | **Is one of** / **Is not one of**, and the statuses you pick                   |
| Ticket priority       | **Is one of** / **Is not one of**, and the priorities you pick                 |
| Who it is assigned to | Nobody is assigned / Assigned to an agent / Assigned to a team                 |
| Ticket tag            | **Any of them** / **All of them** / **None of them**, and the tags you pick    |
| Contact tag           | The same three choices, against tags on the customer rather than on the ticket |
| Ticket age            | **At least** or **At most** so many minutes since the ticket opened            |
| Business hours        | The ticket is **Inside business hours** or **Outside business hours**          |

**Who it is assigned to** can be narrowed or left open. **Assigned to an agent** with
**Anyone** selected means "somebody has this"; pick a name to mean one person. The same
applies to **Assigned to a team** and **Any team**.

**Ticket tag and Contact tag are different things.** A ticket tag is on the piece of work; a
contact tag is on the customer. A workflow can add ticket tags but never contact tags.

**Ticket age is inclusive.** **At least** `120` matches a ticket that is exactly two hours
old.

If your workspace has no tags yet, the tag conditions say so and there is nothing to pick.

### Actions

Actions run in the order you list them, and you can have up to five.

| **Do**              | What happens                                                      |
| ------------------- | ----------------------------------------------------------------- |
| Tag the ticket      | Adds a tag you choose. A ticket that already has it is left alone |
| Reassign the ticket | Hands the ticket to a team or to one agent                        |
| Notify someone      | Records a notification for the supervisors, one agent, or a team  |
| Change the status   | Moves the ticket to the status you choose                         |
| Change the priority | Sets the priority you choose                                      |

**Order matters, and a failure stops the rest.** "Reassign to the Escalations team, then
notify that team" is the right order. If the reassign fails, the notify does not run — which
is deliberate, because telling somebody about work they did not receive is worse than
silence.

**Reassign and Notify only reach active people.** An agent who has been removed or
suspended, or who has been invited but has not signed in yet, is not a valid target. If the
person a workflow names stops being active, the workflow switches itself off — see
[When a workflow switches itself off](#when-a-workflow-switches-itself-off).

**Notify** asks who: **The supervisors**, **One agent** or **A team**. The supervisors option
resolves to the supervisors responsible for that ticket, so you do not have to name anybody.
Under **Note** you can add up to 280 characters, shown exactly as you type it — there is no
way to insert the ticket's details into it. The ticket number is included automatically.

> ⚠️ **A notification a workflow sends is recorded but is not yet shown anywhere in the
> workspace.** The alerts screen lists missed SLAs only. Until that changes, treat **Notify**
> as something that will be visible later rather than something a colleague will see today,
> and use **Reassign the ticket** or **Tag the ticket** when somebody has to act now.

**Change the status cannot do what an agent could not do.** Moving a closed ticket back to
open is refused, and the history records it as refused.

## Test a workflow before you turn it on

The test checks a workflow against one real ticket and reports what **would** happen.
**Nothing is changed** — no ticket is touched and nobody is notified.

1. Find the workflow in the list and select **Test**.
2. Enter a **Ticket ID**. This is the long identifier at the end of the ticket's web address:
   open the ticket, and copy everything after `/tickets/` from the address bar.
3. Select **Run test**.

You get one of two answers — _This workflow would run on that ticket._ or _This workflow
would not run on that ticket._ — with each condition marked **Held** or **Did not hold**, and,
when it would run, a plain-language list of what each action would do.

**The test checks the conditions, not the trigger.** It answers "does this ticket match", not
"would this ticket have triggered it". A workflow triggered by **A ticket is created** will
still report a match against a three-week-old ticket whose status fits; that tells you your
conditions are right, and the trigger decides when they are consulted.

Pick a ticket you expect to match and one you expect not to. A workflow with no conditions
always matches, and the test says so.

## Turn a workflow on

Find it in the list and select **Turn on**. It starts acting on tickets from that moment; it
does not go back over tickets that already happened.

To stop it, select **Turn off**. The workflow stays in the list with everything it does
intact, and stops running immediately. **Turning a workflow off is almost always better than
deleting it** — deleting one destroys its run history too.

## Change the order

Use **Move up** and **Move down** on any workflow. The number at the top of each card is its
place in the order.

Order is **execution** order, not priority. Every matching workflow still runs. It matters
when two workflows write to the same thing on the same ticket — the last one to run is the
answer you keep — and when one workflow's action is what makes another one's conditions true.

## Edit or delete a workflow

Select **Edit** to change anything about a workflow, including its trigger. Saving an edit
does not turn a workflow on or off.

Select **Delete** to remove it. The workflow stops running immediately, its run history goes
with it, and tickets it already changed keep those changes. This cannot be undone.

## Read the history when something looks wrong

**Start here, before you re-read the workflow itself.** Select **History** on the workflow.
The most recent runs are listed newest first, each naming its ticket.

| What a run says          | What it means                                                      |
| ------------------------ | ------------------------------------------------------------------ |
| Ran                      | The conditions matched and the actions finished                    |
| Conditions did not match | The trigger fired, the workflow looked, and the ticket did not fit |
| Queued / Running         | It is happening now                                                |
| Failed                   | Something stopped it. The run says which action and why            |

Under a run that did something, each action carries its own result: **Applied**, **Nothing to
change** (the ticket was already like that), **Failed**, or **Skipped** (an earlier action
failed first).

The reasons a run fails:

| Reason                                           | What to do                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Something it points at no longer exists          | Edit the workflow and pick a replacement, then turn it back on      |
| That status change is not allowed on this ticket | Choose a different status, or narrow the conditions                 |
| The ticket was gone by the time it ran           | Nothing — the ticket was deleted between the trigger and the action |
| This ticket hit the hourly limit                 | Two of your workflows are probably triggering each other. See below |
| Something went wrong on our side                 | Not yours to fix. Report it with the ticket number and the time     |

**An empty history is an answer too.** _This workflow has not run since it was created_ means
the trigger has not fired for it — most often because the workflow is switched off, or
because no ticket has done the thing it waits for.

## When a workflow switches itself off

A workflow that points at a tag, team or agent that no longer exists is switched off
automatically, and shows **This workflow needs attention** with what it lost.

Tags and teams cannot be deleted while a workflow uses them, so this almost always means an
**agent** was removed — which always succeeds, because cutting somebody's access must never
be blocked by a rule.

To repair it:

1. Select **Edit** on the workflow.
2. Replace the missing tag, team or agent with a valid one and save. The warning clears.
3. Select **Turn on**.

**Turn on** stays unavailable while something is still missing, and says so. This is two
steps on purpose: repairing a workflow does not arm it, so nothing starts running again until
you say so.

## Renaming a team or a tag is safe

A workflow remembers _which_ tag, team or agent you picked, never what it was called. Rename
the Escalations team and every workflow that reassigns to it keeps working, showing the new
name the next time you open the page. There is nothing to republish and nothing to check.

## Limits

| Limit                                         | Value          |
| --------------------------------------------- | -------------- |
| Workflows in a workspace, on and off together | 50             |
| Workflows using **A ticket stays unresolved** | 10             |
| Conditions in one workflow                    | 10             |
| Actions in one workflow                       | 5              |
| Tags in one tag condition                     | 25             |
| Automated changes to one ticket, per hour     | 20             |
| Workflow name                                 | 80 characters  |
| **Note** on a notification                    | 280 characters |

The per-hour limit exists to stop two workflows setting each other off for ever. A ticket
that reaches it stops being changed for the rest of that hour, and the runs that were refused
appear in the history — so you can see which pair of workflows is arguing.

## Troubleshooting

**A workflow is on and nothing is happening.** Open **History** first. If it is empty, the
trigger has not fired: check you picked the trigger you meant, and remember that **A ticket is
created** only ever applies to new tickets. If the runs say _Conditions did not match_, use
**Test** against a ticket you expected to match and read which condition did not hold.

**My business-hours condition never matches.** Until the workspace's business hours are set,
that condition is false both ways — **Inside business hours** and **Outside business hours**
alike — so the workflow never runs. This is deliberate: guessing would make "out of hours,
escalate" fire on every ticket in a workspace that never configured anything. Set business
hours in **Settings**, and the condition starts working.

**A contact-tag condition never matches.** A ticket with no customer record attached cannot
be checked against contact tags, and the condition is treated as not holding. Use a ticket
tag instead if the ticket may not have a contact.

**I cannot turn a workflow on.** Something it points at is missing — see
[When a workflow switches itself off](#when-a-workflow-switches-itself-off).

**Reordering was refused, or the list looks stale.** Somebody else added or removed a
workflow while your page was open. Reload the page and reorder again; the workspace refuses a
half-applied order rather than guessing.

**Two workflows are fighting over a status.** Both are running, in the order shown, and the
last one wins. Narrow one of them with a condition, or move it so it runs first and let the
other one's conditions exclude the result.

**A workflow escalated a ticket once and never again.** That is by design for **A ticket
stays unresolved** — it fires once per ticket, ever. To catch a ticket a second time, use a
different trigger, or a second workflow with a longer threshold.
