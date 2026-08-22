# Set up the chatbot and its knowledge base

**Who this is for:** workspace admins. No technical knowledge is assumed. If you are building
against the API, read [the AI chatbot and knowledge base API reference](../reference/chatbot-api.md)
instead. If you are an agent meeting the chatbot in the Inbox, read
[Work with the chatbot in the inbox](work-with-the-chatbot-in-the-inbox.md).

The **chatbot** answers customers on WhatsApp for you. It answers **only** from entries you
write into the **knowledge base** — your returns policy, your delivery times, your opening
hours. When it is not sure enough, or the customer asks for a person, it hands the
conversation over to your team and tells them what it did.

**With an empty knowledge base the chatbot says nothing at all.** It never invents an answer,
and it never guesses from general knowledge. That is not a setting you can turn off; it is how
the product is built. So the first thing you do here is write something for it to answer from.

Only a workspace admin can open **Settings → Chatbot**. Supervisors and agents cannot see it.

## Before you start

- You are signed in as a workspace **admin**.
- Your workspace's plan includes the chatbot. If it does not, the page opens read-only and
  says so.
- You have something to write down: the questions your team answers most often, and the
  answers your workspace has agreed on.

## 1. Open the chatbot settings

Select **Chatbot** in the settings navigation, or go to `/settings/chatbot`.

The page has three parts, in this order:

| Part                  | What it tells you                                             |
| --------------------- | ------------------------------------------------------------- |
| **Automated replies** | Whether customers are getting automated replies **right now** |
| **Chatbot settings**  | When the chatbot replies, and when it hands over              |
| **Knowledge base**    | What the chatbot is allowed to answer from                    |

**Automated replies** comes first on purpose. A switch labelled **On** tells you nothing about
whether there is anything to answer from, so the page answers the real question at the top.

On a new workspace it reads **The chatbot is not answering**, followed by every reason —
not just the first. Work down that list.

## 2. Add your first knowledge base entry

1. Scroll to **Knowledge base** and select **Add entry**.

   The dialog **Add a knowledge base entry** opens.

2. Type a **Title** — what the entry is about, for your own team. For example
   `Returns and refunds policy`. The customer never sees it.

3. Write the answer in **What the chatbot should know**.

   Write it the way you would explain it to a customer. **Separate topics with a blank line.**
   Each block between blank lines becomes a piece the chatbot can find on its own, so an entry
   split into short paragraphs is found more often than one long block of text.

   ```text
   Unopened items can be returned within 30 days of delivery for a full refund.

   Opened items can be returned within 14 days if the packaging is intact.

   Refunds reach your card 5 to 7 working days after we receive the item.
   ```

4. Optionally fill in **Where this came from** — a link to the page or document this text came
   from. It is a note for your own team; the customer never sees it.

5. Optionally pick a **Language**. This is also for your own team: search works the same
   whichever you pick.

6. Select **Add entry**.

   A message reads **"Returns and refunds policy" added — indexing now**, and the entry appears
   in the table with the status **Indexing**.

7. Wait a moment, then refresh the page.

   The status changes to **Ready**, and **Indexed pieces** shows how many pieces the entry was
   split into. **Ready** is the only status the chatbot can answer from.

Repeat for each topic. One entry per subject reads better than one entry for everything: it
makes the **Answered from** line your agents see after a handover actually useful.

### What the statuses mean

| Status       | What it means                                         |
| ------------ | ----------------------------------------------------- |
| **Indexing** | Being split for search. The chatbot cannot use it yet |
| **Ready**    | The chatbot can answer from this                      |
| **Failed**   | It could not be indexed, so the chatbot ignores it    |

A **Failed** entry shows **Why it failed** on its row. Select **Index again** on that row to
retry. **Index again** is also how you retry an entry that has been stuck on **Indexing** for
longer than a minute or two.

### Editing and deleting

- **Edit** opens the entry with its full text. Changing the text re-indexes it, and the
  chatbot stops using that entry until indexing finishes. Changing only the title or the link
  does not re-index.
- **Delete** removes the entry, and the chatbot stops answering from it. This cannot be
  undone.

**Deleting your only entry switches automated replies off.** The confirmation says so when
that is what you are about to do. Nothing breaks — every conversation simply goes to your team
again, exactly as it did before you set the chatbot up.

## 3. Switch automated replies on

1. Scroll to **Chatbot settings**.

2. Turn on **Answer customers automatically**.

3. Select **Save changes**.

   A message reads **Chatbot settings saved**.

4. Scroll back to **Automated replies**.

   It now reads **The chatbot is answering**, with the number of entries it answers from. If it
   still reads **The chatbot is not answering**, the remaining reasons are listed there — see
   [If the chatbot is not answering](#if-the-chatbot-is-not-answering).

The chatbot only replies inside WhatsApp's 24-hour window, which a customer's own message
opens. It never starts a conversation.

## 4. Tune when it replies and when it hands over

Everything below is optional and has a working default. Select **Save changes** after any
edit.

| Setting                                   | Default     | What it does                                                                                                                                   |
| ----------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Model**                                 | Recommended | A faster model costs less per reply and is less careful about what it does not know. The price per million tokens is shown next to each option |
| **Confidence needed to reply**            | 60%         | How sure the chatbot must be before it replies instead of handing over                                                                         |
| **Replies before handing over**           | 5           | The most it answers in one conversation before a person takes it, however confident it is                                                      |
| **How the chatbot should sound**          | Empty       | Tone and house rules — "answer in the customer's language", "never quote a price"                                                              |
| **Words that ask for a person**           | Empty       | Any message containing one of these hands over immediately                                                                                     |
| **What the customer is told on handover** | Empty       | Sent once per conversation when the chatbot gives up. Leave blank to say nothing                                                               |

### Confidence needed to reply

Both halves have to clear the bar: the search has to find something that matches, **and** the
chatbot has to say it used what it found. Whichever is lower is the score, so a confident-
sounding answer built on a weak match still hands over. That is deliberate — it is the case
that produces a confident wrong answer.

Raise it to hand over more often. Lower it to let the chatbot answer more. The slider moves in
steps of five points, so a value you read back is one somebody chose. Start at the default,
then watch **Why it stopped** on real handovers for a week before changing it.

### How the chatbot should sound

Tone and house rules only. **It never overrides the knowledge base.** Writing "answer any
question about delivery" here does not give the chatbot anything to answer with — only a
knowledge base entry does.

### Words that ask for a person

Enter one per line, for example:

```text
agent
human
speak to someone
```

Any message containing one of these hands over immediately, before the chatbot looks anything
up. Matching ignores capitals and Arabic diacritics, and matches **inside** words — so `agent`
matches "an agent!" and also, unhelpfully, "urgently". Keep the words distinctive, and check
this list first if the chatbot hands over more often than you expect.

### What the customer is told on handover

Sent once per conversation, when the chatbot gives up mid-conversation. For example:
`One moment — I'm passing you to a colleague.`

Leave it blank if you would rather your customers hear nothing than an apology. Blank is the
default. It is never sent for an opening message the chatbot could not answer, so a customer
who says "hi" and gets no match is not apologised at.

## If the chatbot is not answering

**Automated replies** lists every reason at once. Fix them in any order.

| It says                                                             | Do this                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **The knowledge base is empty, so there is nothing to answer from** | Add an entry and wait for it to reach **Ready**. See [step 2](#2-add-your-first-knowledge-base-entry) |
| **The chatbot is switched off below**                               | Turn on **Answer customers automatically** and select **Save changes**                                |
| **The chatbot is not included in this workspace's plan**            | Upgrade the plan. Until then the settings are read-only                                               |
| **The AI provider is not configured on this platform**              | Only the platform operator can change this. Contact support                                           |

If every entry sits at **Ready** and the panel says the chatbot is answering, but customers
still get no automated reply, the likely causes are:

- **The conversation was already handed over, or an agent has replied in it.** The chatbot
  never resumes a conversation a person has taken. It starts fresh once that conversation is
  resolved.
- **The customer's message had no text** — a photo, a sticker, a location pin. There is
  nothing to search on.
- **The contact has opted out of messages.** Nothing is sent to them automatically.
- **The question is not in the knowledge base.** Open the conversation in the Inbox and read
  **Why it stopped** under **What the chatbot did**.

## What this cannot do yet

- **You cannot upload a file or import a web page.** Knowledge base entries are typed or
  pasted in. **Where this came from** is a link for your team; nothing reads it.
- **You cannot search or page through the knowledge base on this screen.** The table shows the
  10 most recent entries and says so when there are more. The chatbot searches every entry,
  not only the ones shown.
- **You cannot see how often the chatbot answered, handed over, or what it cost.** There is no
  chatbot report. What you can see is one conversation at a time, in the Inbox.
- **A workspace holds at most 1000 entries**, and one entry holds at most 256 KB of text. If
  an entry is refused as too long, split it into two.
- **Only an admin can reach this page.** A supervisor cannot add or edit knowledge base
  entries.
