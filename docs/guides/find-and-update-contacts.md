# Find a contact and keep their record up to date

**Who this is for:** agents and supervisors working customer conversations. No technical
knowledge is assumed. If you are building against the API, read
[the contacts, tags and custom fields API reference](../reference/contacts-api.md) instead.

A **contact** is one customer who has written in to your workspace. Every conversation
belongs to one. This guide covers finding a contact, tagging them, and filling in the fields
your admin has defined.

Every agent can do everything on this page. Defining which custom fields exist is an admin
job — see [Define the fields your contacts carry](define-custom-contact-fields.md).

## Before you start

- You are signed in to your workspace.
- Contacts already exist. **You do not create them**: a contact appears the first time
  somebody messages your workspace.

## Find someone in the directory

1. Select **Contacts** in the left navigation. The directory opens, most recent first.
2. Use the search box to search by **name, phone or email**. Type part of what you know —
   capitals do not matter for a name or an email address.
3. Use **Filter by tag** to narrow the list to everyone carrying one tag.

Search and the tag filter work together, and both live in the page address — so a filtered
view is a link you can send to a colleague, and the back button takes you where you expect.

The directory shows **Name**, **Phone**, **Email**, **Tags** and **Last contacted**. Select a
row to open that person's profile.

If nothing matches, the page says **No contacts match this filter**. Select **Clear filters**
to see everyone again.

> The list shows the first page of contacts. If you see **Showing the first 25 contacts.
> Search to find someone further down the list**, search rather than scrolling — search looks
> across the whole workspace, not just the rows on screen.

## Filter the directory by tag

This is the fastest way to answer "who are all our VIP customers".

1. On the **Contacts** page, open **Filter by tag**.
2. Choose a tag. The list immediately narrows to contacts carrying it.
3. Choose **All tags** to clear it.

You can filter by **one tag at a time**. To combine a tag with something else, add a search
term — "everyone tagged VIP whose name contains Haddad" is a tag plus a search, not two tags.

> If the dropdown says **Showing the first 100 tags. Not every tag is listed**, your workspace
> has more tags than the filter can list. A tag missing from the dropdown still exists and
> still works.

## Read a contact's profile

Select a contact to open their profile. It has three cards.

**Identity** — the customer's **Phone**, **Email**, **WhatsApp profile name**, **Last
contacted** and **First seen**. The phone number is the customer's WhatsApp identity and
cannot be changed here.

**Tags** — every tag in the workspace, with this contact's ticked.

**Custom fields** — the fields your admin has defined, with this contact's values.

If a contact has opted out, the profile says so. **Opted out** blocks every outbound message
to them, templates included.

## Tag a contact

Tags are shared across the workspace, and routing rules read them — tagging a customer `VIP`
can be what sends their next ticket to the right team.

1. Open the contact's profile.
2. In the **Tags** card, tick the tags that apply and untick the ones that do not.
3. Select **Save tags**.

A message confirms the tags were updated.

**Saving replaces the whole set**, which is why the card shows every tag in the workspace
rather than only the ones already applied — what you leave ticked is what the contact ends up
with.

A tag the contact holds that is no longer in the workspace still appears, ticked, marked **No
longer available in this workspace** — so you can untick it. If instead it says **Not in the
first 100 tags in this workspace**, the tag is fine; it just sorted past what the card could
list.

**You cannot create a tag from the console yet.** If the card says **No tags have been created
in this workspace yet**, there is nothing to apply — ask whoever manages your workspace's
integrations to add the tags your team needs.

## Fill in a contact's custom fields

1. Open the contact's profile.
2. In the **Custom fields** card, fill in what you know. Each field takes the kind of value
   its type calls for — free text, a number, **Yes**/**No**, a date, or one option from a
   list.
3. Select **Save fields**.

A message confirms the fields were updated. **Save fields** stays unavailable until you
change something; the card says **Nothing has changed yet** rather than leaving a dead button.

**Only what you changed is saved.** Fields you did not touch stay exactly as they were, so
you and a colleague can update different fields on the same contact at the same moment and
both changes are kept. To empty a field, clear its control and save — that clears it
deliberately.

If the card says **No custom fields yet**, nobody has defined any. An admin can define fields
such as "Plan tier" or "Account manager" under **Settings** → **Custom fields**.

### If a choice is marked "No longer an option"

Your admin removed that option from the field after this value was stored. The note reads
**No longer an option. Saving keeps it unless you pick another**, and it means what it says:
the old value stays until you replace it, and saving a different field on this contact does
not disturb it. Pick a current option if you know which one is right.

## Troubleshooting

| What you see                                          | What it means                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| **You do not have permission to change this contact** | You can read the record but not edit it. Ask a colleague with edit rights       |
| **That contact is not available**                     | The link is out of date, or the contact belongs to another workspace            |
| **Must be a number**                                  | The field takes a number. Remove any currency symbol, spaces or letters         |
| **Must be one of the defined options**                | Pick from the list rather than typing a value                                   |
| **Must be a calendar date**                           | Use the date control, or type the date as `2027-03-01`                          |
| **No contacts yet**                                   | Nobody has messaged this workspace. A contact is created by their first message |
| A tag you expect is missing from the filter           | Your workspace has more than 100 tags; the filter says so above the dropdown    |

## What this cannot do yet

- **You cannot create a contact.** One appears when somebody first messages your workspace.
- **You cannot create or delete a tag** from the console — only apply and remove existing
  ones.
- **You cannot filter by more than one tag at a time.**
