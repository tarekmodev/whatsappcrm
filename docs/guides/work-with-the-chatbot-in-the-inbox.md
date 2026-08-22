# Work with the chatbot in the inbox

**Who this is for:** agents and supervisors working conversations in the **Inbox**. No
technical knowledge is assumed. If you set the chatbot up rather than work alongside it, read
[Set up the chatbot and its knowledge base](set-up-the-chatbot.md). If you are building
against the API, read
[the AI chatbot and knowledge base API reference](../reference/chatbot-api.md).

If your workspace has the **chatbot** switched on, some customers get an answer before anybody
on your team sees the conversation. The chatbot answers only from your workspace's knowledge
base, and when it cannot answer it hands the conversation over to you — with a summary of what
it tried.

You need no extra permission for any of this. Every role can take a conversation from the
chatbot.

## What the badges mean

A conversation carries a badge when the chatbot has been involved. A conversation it never
touched carries none, which is the ordinary case.

| Badge                   | What it means                                               | What to do                          |
| ----------------------- | ----------------------------------------------------------- | ----------------------------------- |
| **Bot is answering**    | The chatbot is handling this. Nobody on your team needs to  | Nothing, unless you want to step in |
| **Bot handed over**     | The chatbot gave up, and **nobody has taken it yet**        | This is the one that needs a person |
| **You have taken over** | Somebody stepped in. The chatbot will not answer here again | Reply as normal                     |

**Bot handed over** is the badge to watch. The chatbot has stopped, the customer is waiting,
and the conversation is not yet anybody's.

## Read what the chatbot did

Open a conversation the chatbot has been involved in. The right-hand column shows a card
titled **What the chatbot did**.

The exchange itself is not repeated there — the chatbot's replies are real messages, sent to
the customer, so they are already in the conversation above, captioned **Sent by the chatbot**.
The card carries what the conversation cannot show you:

| Line                              | What it tells you                                   |
| --------------------------------- | --------------------------------------------------- |
| **Why it stopped**                | The reason it handed over                           |
| **Handed over**                   | When                                                |
| **The message it could not take** | The customer's question you now have to answer      |
| **Replies before handing over**   | How many times it answered first                    |
| **How sure it was**               | Its confidence, and the two halves that produced it |
| **Answered from**                 | Which knowledge base entries it used                |

### Why it stopped

| It says                                                      | What happened                                             |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| **It was not sure enough of the answer**                     | It found something, but not clearly enough to send        |
| **It found nothing in the knowledge base about this**        | Nothing in the knowledge base covers the question         |
| **The customer asked for a person**                          | The message contained one of the words your workspace set |
| **It had already replied as many times as it is allowed to** | The conversation hit the reply limit                      |
| **Somebody on your team took the conversation**              | An agent selected **Take over from the bot**              |
| **It could not complete the reply**                          | Something went wrong on the chatbot's side                |

### Answered from

**Read this line before you reply.** It names the knowledge base entries the chatbot drew on.
If a customer asked about shipping and this says **Returns and refunds policy**, the chatbot
answered from the wrong material — the customer has a confident, wrong answer above your
reply, and you need to correct it rather than continue from it.

If it reads **It cited nothing from the knowledge base**, the chatbot never got as far as
using an entry.

### How sure it was

A percentage, with the two halves under it: how sure the model was, and how well the knowledge
base matched. The lower of the two is the score, so a low **knowledge base** figure means the
chatbot was answering from thin material however confident it sounded.

**It never reached the model, so there is no score** means the chatbot stopped before it tried
to answer — the customer asked for a person, or nothing matched at all.

## Take a conversation from the chatbot

While the chatbot is answering, a notice above the conversation reads **The chatbot is
answering this conversation. Take it over to reply yourself — the chatbot stops for good once
you do.** Without it, a conversation the chatbot is handling would look like one everybody is
ignoring.

1. Open the conversation in the **Inbox**.

2. Select **Take over from the bot**, at the top of the conversation.

   A message confirms the chatbot has stopped answering that customer, and the badge changes
   to **You have taken over**.

3. Reply as you would to any other conversation.

**This is final for that conversation.** The chatbot does not resume, however confident it
would have been — a chatbot that started answering again would be talking over you in front of
the customer. It starts fresh the next time that conversation is resolved and the customer
comes back.

Selecting it twice does nothing the first time did not. The button is only offered while the
chatbot actually holds the reply.

## What this cannot do yet

- **You cannot hand a conversation back to the chatbot.** Taking over is one-way for that
  conversation.
- **You cannot switch the chatbot off from the Inbox**, for one contact or in general. That is
  **Settings → Chatbot**, and only a workspace admin can reach it.
- **You cannot correct the knowledge base from here.** If the chatbot answered from the wrong
  entry, tell an admin which entry it was — the **Answered from** line names it.
- **There is no list of conversations the chatbot handed over.** Watch for the **Bot handed
  over** badge in the conversation list.
