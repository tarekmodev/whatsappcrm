# Keep the workspace's saved replies up to date

**Who this is for:** supervisors and admins who decide what standing text the workspace's
agents can insert. No technical knowledge is assumed. If you are an agent inserting one in a
conversation, read
[Answer common questions with saved replies](use-saved-replies.md) instead. If you are
building against the API, read
[the canned responses API reference](../reference/canned-responses-api.md).

A **saved reply** is a piece of text your workspace has written once — opening hours, a VAT
number, a returns policy — so that nobody has to type it again. An agent inserts one by typing
a shortcut such as `/hours` into the reply box.

The list is shared by the whole workspace. There is one list, everybody sees it, and the
customer gets the answer your workspace agreed on rather than the one an agent remembered.

## Before you start

- You are signed in as a **supervisor or an admin**. Agents cannot reach this screen — the
  **Saved replies** entry does not appear in their navigation, because an agent uses the list
  rather than keeps it.
- A workspace can hold up to **200** saved replies.
- Decide the shortcut before you start typing. It is the thing an agent has to remember in the
  middle of a conversation, so it is worth more thought than the name.

## Find the saved replies screen

1. Select **Settings** in the left navigation, then **Saved replies**. The **Saved replies**
   page opens.

The page lists every saved reply **in shortcut order**, with a count — for example, "3 saved
replies of 200. Everybody in this workspace sees the same list." Each row shows the
**Shortcut**, the **Name**, and the start of the **Text**. A long reply is cut short in the
table; open **Edit** to read all of it.

If your workspace has none yet, the page reads **No saved replies yet**.

## Add a saved reply

1. Select **Add saved reply**. The **Add a saved reply** dialog opens.
2. Enter the **Shortcut**, such as `/hours`. This is what an agent types in the reply box.
3. Enter the **Name**, such as `Opening hours`. This is what agents see beside the shortcut
   when they pick from the list, so it should say what the reply is for.
4. Enter the **Text**. It is inserted exactly as written — see
   [What the text cannot do](#what-the-text-cannot-do).
5. Select **Add saved reply**.

A message confirms the reply is ready for every agent to use. **Nobody has to reload.** An
agent with a conversation open sees the new shortcut work on their next keystroke.

### Writing a shortcut

The screen corrects two things for you the moment you leave the box, so you do not have to
get the punctuation right:

- **A missing `/` is added.** Type `hours` and it becomes `/hours`.
- **Capitals are lowered.** Type `/Hours` and it becomes `/hours`.

Neither is pedantry the field could have left to you. Shortcuts are matched without regard to
case, so `/Hours` and `/hours` are the same shortcut — a screen that refused one of them would
be enforcing a distinction the workspace does not make.

What is left for you to get right:

| Rule                                                 | Example                                 |
| ---------------------------------------------------- | --------------------------------------- |
| Starts with `/`, then a **letter or a number**       | `/hours`, `/2fa` — not `/_hours`        |
| After that, lowercase letters, numbers, `-` and `_`  | `/out-of-hours`, `/vat_number`          |
| No spaces, and no second `/`                         | `/opening-hours`, not `/opening hours`  |
| At most **40** characters, counting the `/`          |                                         |
| Different from every other shortcut in the workspace | See [Troubleshooting](#troubleshooting) |

A **name** is up to 80 characters. The **text** is up to 4096 — the longest message WhatsApp
accepts — so a reply an agent inserts into an empty reply box is always sendable.

### What the text cannot do

The text is inserted exactly as you write it. **Nothing is filled in automatically** — there is
no way to have a saved reply carry the customer's name, the ticket number, or any other
detail. Write text that is true for every customer who will receive it, and leave the parts
that differ to the agent, who can edit the text in the reply box before sending.

## Change a saved reply

1. On the row you want to change, select **Edit**. The dialog opens with the shortcut, the
   name and the text as they stand.
2. Change any of the three. Unlike a custom field's key, **the shortcut is not fixed** — an
   agent types it in the moment rather than filing anything under it, so renaming one breaks
   nothing that outlives the keystroke.
3. Select **Save changes**.

**Save changes** stays unavailable until something differs from what is saved, so a dialog you
opened to read is a dialog you can close without a write.

Two things this does not disturb:

- **Messages already sent are not touched.** The text was copied into the agent's reply box
  when they inserted it, so what the customer received is theirs and stays as it was sent.
- **An agent holding the old text keeps it.** If somebody has already inserted the reply into
  their reply box, your edit does not rewrite what they are about to send. Every agent's list
  updates on its own; what is already in a draft is that agent's text now.

## Delete a saved reply

1. On the row you want to remove, select **Delete**. A confirmation appears.
2. Read what it names: the reply disappears from every agent's reply box, and its shortcut
   stops inserting anything. Messages already sent are untouched. **This cannot be undone** —
   there is no restore, so re-adding a deleted reply means typing the text again.
3. Select **Delete saved reply**.

## What agents see

Agents never open this screen. They meet the list in the **Inbox**: typing `/` in the reply
box opens a list of at most eight matches, ordered by shortcut first and name second, and
**Enter** inserts the highlighted one into the box without sending it.

Two consequences worth keeping in mind while you write the list:

- **A shortcut is only recognised at the start of a message or after a space**, so an agent
  who pastes a web address ending in `/hours` does not get a menu mid-link.
- **The text of a reply is not searched.** An agent who cannot remember the shortcut sees only
  the first eight replies in the list. Past a few dozen replies, the names are what makes one
  findable, so write names an agent would guess.

The whole of what an agent sees is
[Answer common questions with saved replies](use-saved-replies.md) — worth reading once, since
it is the half of this feature you do not use yourself.

## Troubleshooting

One message below says **canned response** and **tenant** where the rest of the console says
_saved reply_ and _workspace_. It comes from the part of the product that stores the library
rather than from the screen, and it means the same thing.

| What you see                                                                                      | What it means                                                                                                                                |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| No **Saved replies** entry under Settings                                                         | You are signed in as an agent. Ask a supervisor or an admin to make the change                                                               |
| **This field is required**                                                                        | A shortcut, a name and a text are all needed. None may be blank                                                                              |
| **Start with /, then lowercase letters, numbers, - or \_**                                        | The shortcut has a space, a second `/`, or an opening `-` or `_`. See [Writing a shortcut](#writing-a-shortcut)                              |
| **A shortcut is at most 40 characters, including the leading /**                                  | Shorten it. A shortcut an agent has to type in full is better short anyway                                                                   |
| **A canned response for `/hours` already exists in this tenant. Shortcuts are case-insensitive.** | Another saved reply uses that shortcut. Edit that one instead, or pick another shortcut — `/Hours` does not count as different               |
| **This workspace has all 200 saved replies it may hold. Delete one to add another.**              | You are at the limit, and the **Add saved reply** button is hidden until you delete one                                                      |
| **We could not save that. Check the fields and try again.**, with a **Reference** code            | Something went wrong that the screen cannot name. Try again; if it keeps happening, give whoever supports your workspace the reference shown |

## What this cannot do yet

- **There are no personal saved replies.** Every reply belongs to the whole workspace. An
  agent cannot keep a private one, and you cannot write a reply for one team.
- **Nothing records which replies get used.** There is no way to find the ones nobody inserts,
  so a list nobody prunes can only be pruned by reading it.
- **You cannot reorder the list.** It is always in shortcut order.
- **There is no undo, and no history.** A deleted reply is gone, and there is no screen showing
  what a reply used to say — although who changed which reply, and when, is recorded in the
  workspace's audit trail.
