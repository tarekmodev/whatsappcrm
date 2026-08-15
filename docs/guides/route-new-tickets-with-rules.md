# Route new tickets to the right team

**Who this is for:** supervisors and admins who decide where incoming work goes. No
technical knowledge is assumed. If you are building against the API, read
[the assignment rules API reference](../reference/assignment-rules-api.md) instead.

A **routing rule** is a standing instruction: _when a new ticket looks like this, send it
to that team or agent._ A rule that says "if the message mentions billing, send it to the
Billing team" puts every matching ticket in front of the right people without anyone
triaging it by hand.

Rules run **once, at the moment a ticket opens** — when a customer writes in and no ticket
is already running for them. Rules never re-route a ticket somebody is already working on.

## Before you start

- You are signed in to your workspace as a supervisor or an admin. Agents cannot see or
  change routing rules.
- The teams and agents you want to route to already exist. Create teams on the **People**
  page first.
- For a rule that matches on a tag or a contact field, that tag or field already exists in
  your workspace. You choose from what is there; you cannot create one while writing a
  rule.

## How routing decides

Every new ticket goes through the same three steps.

1. **Your rules are checked in order, from the top.** The **first** rule that matches
   decides where the ticket goes, and no rule below it is considered.
2. **A rule only matches if _every_ one of its conditions holds.** Conditions within a
   rule combine with "and". To express "or", either put several words in one condition or
   write a second rule.
3. **If no rule matches, the ticket goes to the usual rotation** — the workspace picks an
   available agent by turn and by how much they are already carrying. Routing rules do not
   replace that; they are the exception you write on top of it.

Two consequences worth knowing before you write your first rule:

- **Order is the whole design.** A broad rule near the top swallows tickets a narrower rule
  below it was meant to catch. Put your most specific rules first.
- **A rule that sends work to a team stops there.** The ticket belongs to that team, and a
  member picks it up; the rotation does not then choose a person inside the team.

## Find the rule list

1. Select **Settings** in the left navigation, then **Assignment**. The **Assignment and
   reporting** page opens.
2. Find the **Routing rules** section.

The section lists your rules **in the order they are checked**, top first. Each card shows:

- **Rule 1**, **Rule 2** and so on — its place in the order.
- The rule's name, and an **Active** or **Off** badge.
- **Matches when** — a plain-language summary of its conditions.
- **Route to** — the team or agent it sends work to.

If you have no rules yet, the section says **No routing rules yet**.

## Add a rule

1. In the **Routing rules** section, select **Add rule**. The **Add a routing rule** dialog
   opens.
2. Enter a **Rule name**, such as `Billing keywords`. Names must be unique, and capitals do
   not make two names different. The name appears in a ticket's history as the reason it
   was routed, so make it describe the rule rather than the team.
3. Under **Conditions**, choose what to **Check**:
   - **Words in the message** — the words the customer used.
   - **Contact tag** — a tag on the customer's contact record.
   - **Business hours** — whether the ticket arrived inside or outside your opening hours.
   - **Contact field** — a value stored on the customer's contact record.
4. Fill in that condition. **Words or phrases** takes one entry per line; **Match** decides
   whether **Any of them** or **All of them** must appear.
5. Select **Add condition** to add another. A rule can hold up to 10, and **all of them
   must hold** for the rule to apply.
6. Under **Send to a**, choose **Team** or **Agent**, then pick which one.
7. Select **Add rule**.

A message confirms the rule was added, and it appears at the **bottom** of the list — so it
is checked last. Move it up if it needs to win over an existing rule.

New rules are **Active** straight away and apply to the next ticket that arrives.

### What each condition matches

| Condition                | Matches when                                                                 |
| ------------------------ | ---------------------------------------------------------------------------- |
| **Words in the message** | The words appear anywhere in the customer's first message, ignoring capitals |
| **Contact tag**          | The customer's contact record carries the tags you chose                     |
| **Business hours**       | The ticket arrived inside — or outside — your workspace's opening hours      |
| **Contact field**        | The named field on the contact record satisfies the comparison you chose     |

**Word matching looks inside longer words.** `bill` matches `billing`, and also
`billboard`. Choose words that are specific enough not to catch work you did not mean.

**A photo or a document counts if its caption matches.** The caption is treated as the
message.

**Comparisons for a contact field** are **is exactly**, **is not**, **contains**, **is
filled in** and **is empty**. **contains** ignores capitals, so it treats `Gold` and `gold`
as the same; **is exactly** and **is not** do not.

**is not needs the field to be filled in.** A contact with nothing in that field does not
match "plan is not gold" — there is no value to disagree with. Use **is empty** when that is
what you mean.

**A condition with nothing to read never matches.** A ticket opened without a contact
record cannot match a tag or a contact-field condition, and the rule is skipped rather than
guessed at. The ticket falls through to the next rule, and eventually to the rotation.

## Change the order

Use **Move up** and **Move down** on a rule's card. The order saves as soon as you select
it, and a message confirms it.

Work on one move at a time. The controls stand down while a move is saving, because a
second move computed from the old order would undo the first.

## Turn a rule off without deleting it

Select **Turn off**. The rule stays in the list, shows an **Off** badge, and is skipped
entirely when a ticket arrives. Select **Turn on** to bring it back.

Turning a rule off is the safe way to test whether it is the one sending work somewhere
unexpected. Deleting is not reversible.

## Edit or delete a rule

- **Edit** opens the same dialog with the rule's current values. Select **Save changes**.
  Editing a rule does not change whether it is on or off.
- **Delete** asks you to confirm. The rule stops applying immediately, and **tickets it
  already routed keep their assignment**. This cannot be undone.

## When a rule cannot place a ticket

Two situations look like a rule failing but are the system protecting the ticket.

**The target cannot take work.** If a rule points at an agent whose account is suspended,
or at a team with no active members, the rule is treated as not matching. The ticket
continues down the list, and reaches the rotation if nothing else matches. Nothing is lost,
but the rule is doing nothing — check the target if a rule never seems to fire.

**Nobody is available at all.** If no rule matched and the rotation has nobody free — every
agent is at their ticket limit, away, or offline — the ticket stays unassigned and appears
under **Flagged for you** at the top of the same **Assignment and reporting** page.
Assigning it by hand takes it off that list.

## Why a ticket went where it did

Open the ticket and read its history. A ticket placed by a rule shows **Routed by rule**
followed by the rule's name. One placed by the rotation shows **Assigned by rotation**. One
that could not be placed records why nobody was available.

That history is the first thing to read when routing looks wrong — before the rule list,
because it names the rule that actually won.

## Limits

| Limit                                     | Value |
| ----------------------------------------- | ----- |
| Rules in a workspace, on and off together | 200   |
| Conditions in one rule                    | 10    |
| Words, phrases or tags in one condition   | 25    |
| Characters in one word or phrase          | 80    |

If you are approaching 200 rules, the list is no longer the right tool for what you are
doing — talk to support.

## Troubleshooting

**A rule shows "No target — this rule needs one before it can be turned on", and Turn on
does nothing.**
The agent this rule sent work to was removed from the workspace. The rule was turned off
and kept, rather than deleted, so you can point it somewhere else. Select **Edit** — the
dialog explains the same thing — choose a new team or agent, select **Save changes**, then
**Turn on**.

**"A routing rule named … already exists in this tenant. Rule names are case-insensitive."**
Another rule already has that name. `Billing` and `billing` count as the same name.

**"The rule list changed since you loaded it — somebody added or removed a rule. Reload and
reorder again."**
Another supervisor added or deleted a rule while your page was open, so the order you
submitted no longer describes the list. Reload the page and move the rule again. Nothing
was half-applied.

**"This tenant already has 200 routing rules, which is the maximum. Delete or merge a rule
before adding another."**
You have reached the limit. Several rules that route to the same place can usually be
merged into one with more words in a single condition.

**"This workspace has no contact tags yet, so a tag condition has nothing to match on."**
Nobody has created tags in this workspace. Use a different condition until tags exist.

**"We could not save that. Check the fields and try again."** — after choosing many tags.
You selected more than 25 tags on one condition, which is over the limit, and the message
does not currently say so. Deselect tags until you are at 25 or fewer. A clearer message is
on its way (TAR-371).

**A rule with a business-hours condition never matches.**
Business hours have not been set for your workspace. Until they are, a business-hours
condition never matches and the rule is skipped — deliberately, so a rule meant for
out-of-hours work does not fire on every ticket instead.

> **TODO(author):** there is no console surface for setting business hours today, and no
> tenant-facing endpoint for them either — `tenant_settings.business_hours` is written by
> provisioning and by the seed only. Whoever owns that story should say here how a
> supervisor sets them; until then this guide cannot tell the reader where to go.

**A rule that used to work stopped matching.**
Check whether the tag or contact field it names still exists. A rule pointing at a deleted
tag stays active and never matches again; its **Matches when** summary shows **a deleted
item** where the tag used to be. Edit the rule and choose a tag that exists.

**Nothing routes at all, for any rule.**
Ask an admin to check that the platform's background worker is running. Tickets are still
created when it is not — they simply arrive unassigned, by rule or by rotation alike.
