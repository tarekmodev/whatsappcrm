# Answer common questions with saved replies

**Who this is for:** agents replying to customers in the console. No technical knowledge is
assumed. If you are building against the API, read
[the canned responses API reference](../reference/canned-responses-api.md) instead.

A **saved reply** is a piece of text your workspace has written once — opening hours, a VAT
number, a returns policy — so that nobody has to type it again. You insert one by typing a
shortcut such as `/hours` into the reply box.

Saved replies are shared by the whole workspace. Everybody sees the same list, and it is the
same text every time, which is the point: the customer gets the answer your workspace agreed
on rather than the one you remembered.

**Nothing is ever sent automatically.** Inserting a saved reply puts the text into the reply
box, where you can edit it. It is sent only when you select **Send**.

## Before you start

- You are signed in to your workspace and have a conversation open in the **Inbox**.
- Your workspace has at least one saved reply. If it has none, the list never appears — see
  [If the list does not appear](#if-the-list-does-not-appear).

## Insert a saved reply

1. Open a conversation in the **Inbox** and put the cursor in the **Reply to the customer**
   box.

   The hint under the box reads **The customer receives this on WhatsApp. Type / to insert a
   saved reply.** That hint only appears when your workspace has saved replies.

2. Type `/` followed by the start of the shortcut — for example `/ho`.

   A list opens above the box. Each row shows the shortcut on the left and its name on the
   right, so `/hours` sits beside **Opening hours**. The list narrows as you type.

3. Press the **down arrow** and **up arrow** keys to move through the list. The highlighted
   row is the one that will be inserted.

4. Press **Enter** or **Tab** to insert the highlighted reply. You can also select the row
   with the mouse.

   The shortcut you typed is replaced by the full text. Anything else you had already written
   stays exactly where it was, and the cursor lands at the end of the inserted text so you
   can carry on typing.

5. Edit the text if this customer needs something different, then select **Send**.

### Keys while the list is open

| Key                 | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| **Down** / **Up**   | Move the highlight. It wraps around at the ends                |
| **Enter**           | Insert the highlighted reply. It does **not** send the message |
| **Tab**             | The same as **Enter**                                          |
| **Escape**          | Close the list and keep what you typed                         |
| Any other character | Keeps typing, and the list narrows to whatever still matches   |

**Escape closes the list for the shortcut you are on, not for the message.** Once you type a
different shortcut, the list opens again.

## Where you can type a shortcut

A shortcut is only recognised at the **start of the message** or **after a space**. This is
deliberate: without it, pasting a web address that happens to end in `/hours` would open the
list in the middle of a link.

So `Sure — /hours` works, and `see acme.example.com/hours` does not.

Capitals do not matter. `/Hours`, `/HOURS` and `/hours` all find the same reply.

## What the list matches

Your workspace's saved replies are searched in this order, and the list shows at most
**eight** at a time:

1. **Shortcuts that start with what you typed.** Typing `/ho` finds `/hours` and `/holiday`.
2. **Names that contain what you typed.** Typing `/ho` also finds a reply named **Warehouse
   address**, below the shortcut matches.

The text of a reply is **not** searched. If you cannot remember the shortcut, type `/` on its own
to see the first eight in the list, or ask whoever maintains them in your workspace.

## If the list does not appear

| What you see                                      | Why, and what to do                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No hint about `/` under the reply box             | Your workspace has no saved replies yet, or they could not be loaded. Ask a supervisor or an admin to add some                                                     |
| The list opens and then closes as you keep typing | Nothing matches any more. Delete a character or two                                                                                                                |
| Nothing happens when you type `/`                 | The `/` is inside a word or a web address. Put a space in front of it                                                                                              |
| The reply box is greyed out                       | The conversation is outside WhatsApp's 24-hour window, so you cannot write a free message. The banner above the box explains it; send an approved template instead |
| Your message is refused when you send it          | **That is longer than WhatsApp accepts. Shorten it and try again.** — the inserted text plus what you had already written is over the limit. Trim it and send      |

A saved reply that somebody adds, changes or removes while you have a conversation open
updates on your screen on its own. You do not have to reload the page, and a reply you have
already inserted into the box is left alone — what you are holding is your text now.

## Who keeps the list

Not you — and that is the point of it. Saved replies are written and changed by a supervisor
or an admin under **Settings** → **Saved replies**, which does not appear in your navigation.
If a reply is wrong, out of date or missing, ask one of them; the steps they need are
[Keep the workspace's saved replies up to date](manage-saved-replies.md).

## What this cannot do yet

- **You cannot add or change a saved reply**, or keep one of your own. Every reply belongs to
  the whole workspace.
- **A reply cannot fill anything in for you.** The text arrives exactly as it was written —
  no customer name, no ticket number — so anything specific to this customer is yours to type
  before you select **Send**.
- **You cannot search the text of a reply**, only its shortcut and its name.
