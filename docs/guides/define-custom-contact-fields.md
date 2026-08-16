# Define the fields your contacts carry

**Who this is for:** admins who decide what information the workspace keeps about a
customer. No technical knowledge is assumed. If you are building against the API, read
[the contacts, tags and custom fields API reference](../reference/contacts-api.md) instead.

A **custom field** is an extra piece of information every contact in your workspace carries
— "Plan tier", "Account manager", "Renewal date". You define it once. It then appears on
every contact profile, ready for an agent to fill in, and routing rules can match on it.

Only an admin can define, rename or delete a field. Every agent can see the fields and fill
them in.

## Before you start

- You are signed in to your workspace as an admin. Supervisors and agents cannot reach this
  screen — the **Custom fields** entry does not appear in their navigation.
- Decide the field's **type** before you create it. The type cannot be changed afterwards.
- A workspace can hold up to **50** custom fields.

## What you cannot change later

Two things are fixed the moment you save a field, and knowing which ones saves you a
deletion:

| Fixed    | Changeable                              |
| -------- | --------------------------------------- |
| **Key**  | **Label** — rename it whenever you like |
| **Type** | **Options**, on a **Choice** field      |

The reason is the same for both. The key is how every stored value is filed and how routing
rules refer to the field, so renaming it would lose every value and quietly stop those rules
from ever matching again. The type is what every already-stored value was checked against,
so changing it would leave agents holding a profile they cannot save.

To change either, delete the field and define a new one. **Deleting also deletes every value
your agents have entered.**

## Find the custom fields screen

1. Select **Settings** in the left navigation, then **Custom fields**. The **Custom fields**
   page opens.

The page lists your fields **in the order they appear on a contact profile**, with a count —
for example, "3 fields of 50". Each row shows the field's **Label**, its **Key**, its
**Type**, and its **Options** if it has any.

If you have no fields yet, the page says **No custom fields yet**.

## Define a field

1. Select **Define field**. The **Define a custom field** dialog opens.
2. Enter a **Label**, such as `Plan tier`. This is what agents see on the contact profile,
   and you can rename it at any time.
3. Enter a **Key**, such as `plan_tier`. Use lowercase letters, numbers and underscores,
   starting with a letter. **This is fixed once the field exists.**
4. Choose a **Type**:
   - **Text** — any wording, up to 500 characters.
   - **Number** — a numeric value.
   - **Yes or no** — a two-way switch.
   - **Date** — a calendar date, picked from a date control.
   - **Choice** — one value from a list you supply.
5. If you chose **Choice**, enter the **Options**, one per line — for example `bronze`,
   `silver`, `gold`. Each must be different, and you can have up to 50.
6. Select **Define field**.

A message confirms the field was added to every contact profile, and the new field appears
at the **bottom** of the list — so it renders last on a contact profile.

### Choosing a key

The key is the field's permanent name. A few keys are refused because they would sit
confusingly beside a built-in detail the contact already has: `id`, `phone`, `email`, `name`,
`display_name`, `tags` and `locale`. Pick something else — `account_email` rather than
`email`.

Two fields in the same workspace cannot share a key. If one already uses it, you are told the
key is taken.

## Rename a field, or change its choices

1. On the row you want to change, select **Edit**. The **Edit** dialog opens with the key and
   the type shown but not editable.
2. Change the **Label**, the **Options**, or both.
3. Select **Save changes**.

**Removing an option does not change any contact.** A contact already holding the removed
value keeps it. Their profile shows the old value with the note **No longer an option. Saving
keeps it unless you pick another** — so an agent saving some other field on that contact does
not silently lose it. That is deliberate: the value is out of date, not wrong, and it is the
agent on the conversation who is best placed to correct it.

## Delete a field

1. On the row you want to remove, select **Delete**. A confirmation appears.
2. Read what it says: the field disappears from every contact profile, **and the values
   already stored against it are deleted**. This cannot be undone.
3. Select **Delete field**.

Deleting a field removes the values in the same action, rather than leaving them hidden. If
they were left behind, defining a new field with the same key later would bring every old
value back onto profiles that give no hint they were ever there.

### If a routing rule uses the field

The deletion is refused, and the message names the rules standing in the way. A rule that
matches on a field you have deleted could never match again, and routing that quietly matches
nothing looks like routing that works.

Go to **Settings** → **Assignment**, change or switch off each named rule, then delete the
field.

## What agents see

Open any contact from **Contacts** in the left navigation. The **Custom fields** card lists
every field you defined, in the order shown on your settings page, with a control matching
its type. An agent fills in what they know and selects **Save fields**.

An agent editing one field never disturbs another. Two agents can update different fields on
the same contact without overwriting each other.

Until you define your first field, that card reads **No custom fields yet** — with a link
here for you, and "Ask a workspace admin to define the fields your team needs on a contact"
for everyone else.

## Troubleshooting

| What you see                                                               | What it means                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| No **Custom fields** entry under Settings                                  | You are not signed in as an admin. Ask an admin to make the change                    |
| **Use lowercase letters, numbers and underscores, starting with a letter** | The key has a capital, a space or a hyphen. `plan_tier`, not `Plan Tier`              |
| **That key would shadow a built-in contact field**                         | Pick a different key — see [Choosing a key](#choosing-a-key)                          |
| A message that the key is already taken                                    | Another field in this workspace uses it. Keys cannot be reused while the field exists |
| **A choice field needs at least one option**                               | A **Choice** field cannot have an empty list. Add an option, or use **Text**          |
| **This workspace has all 50 custom fields it may define**                  | Delete a field you no longer need before adding another                               |
| The **Define field** button is missing                                     | You have reached the 50-field limit; a notice above the table says so                 |

## What this cannot do yet

- **You cannot reorder fields from the console.** They appear in the order you created them,
  and there is no way to drag one. Changing the order is possible over the API but has no
  screen yet.
- **You cannot change a key or a type.** Delete and re-create, accepting the loss of stored
  values.
- **Tags are not managed here.** A tag is a label an agent puts on a customer, and it is a
  separate thing from a custom field. Agents apply and remove tags on a contact profile; the
  console has no screen for creating one yet. See
  [Find a contact and keep their record up to date](find-and-update-contacts.md).
