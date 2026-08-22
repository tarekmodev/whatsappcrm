# AI chatbot and knowledge base API reference

The ten routes behind the AI chatbot — the tenant's knowledge base
(`/api/v1/knowledge-documents`), its chatbot configuration (`/api/v1/ai/config`) and the two
handoff routes on a conversation — and the rules the chatbot applies between an inbound message
and either a reply or a human. Written for engineers building against the API or the
console.

The **chatbot** answers a customer's WhatsApp message from the tenant's own knowledge base,
and hands the conversation to a human when it cannot. It is off by default, and it is
structurally incapable of answering from anything other than knowledge-base content the
tenant wrote — see [The empty-knowledge-base guarantee](#the-empty-knowledge-base-guarantee),
which is the rule the rest of this page follows from.

Request and response shapes are defined in `packages/contracts/src/ai.ts` and validated at
the boundary. Enforcement lives in `apps/api/src/ai/`; the database bounds and the two
retrieval indexes are in
`apps/api/prisma/migrations/20260815150000_ai_chatbot_knowledge_base_and_handoff/migration.sql`.
The design this surface implements is
[ADR 0010](../architecture/0010-ai-chatbot-knowledge-base-and-handoff.md).

For a workspace admin writing the knowledge base in the console rather than calling the API,
read [Set up the chatbot and its knowledge base](../guides/set-up-the-chatbot.md). For an
agent meeting the chatbot in the inbox, read
[Work with the chatbot in the inbox](../guides/work-with-the-chatbot-in-the-inbox.md).

## Conventions

| Concern           | Rule                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| Base path         | `/api/v1`                                                                       |
| Tenant            | Resolved from the request `Host`, never from a body, header or query parameter  |
| Bodies            | JSON, `camelCase` keys. Unknown keys are stripped, not rejected                 |
| Lists             | `{ items, nextCursor }`, keyset-paginated on `(created_at DESC, id DESC)`       |
| Timestamps        | ISO 8601 with an explicit offset. Serialised as UTC, so always `Z`              |
| Error shape       | The standard envelope, with a code from `packages/contracts/src/error-codes.ts` |
| `Idempotency-Key` | Not used here. See [Idempotency](#idempotency)                                  |

## Authentication

Every route requires a signed-in user presenting the session cookie `wac_session` —
`__Host-wac_session` wherever `SESSION_COOKIE_SECURE` is on. Three global guards run before
any handler: **where** the request is (`HostTenantGuard`), **who** is making it
(`PrincipalGuard`), then **may they** (`PermissionGuard`).

| Condition                                         | Answer                |
| ------------------------------------------------- | --------------------- |
| No cookie, or an expired, revoked or unknown one  | `401 unauthenticated` |
| A valid session belonging to a different tenant   | `401 tenant_mismatch` |
| Signed in, but the role lacks the permission      | `403 forbidden`       |
| The document or conversation is in another tenant | `404 not_found`       |

## Permissions

| Route                                       | Permission           | Roles that hold it       |
| ------------------------------------------- | -------------------- | ------------------------ |
| `GET /ai/config`                            | `ai:read`            | admin                    |
| `PATCH /ai/config`                          | `ai:write`           | admin                    |
| `GET /knowledge-documents`, `GET …/{id}`    | `ai:read`            | admin                    |
| `POST`, `PATCH`, `POST …/reindex`, `DELETE` | `ai:write`           | admin                    |
| `GET /conversations/{id}/handoff`           | `conversation:read`  | agent, supervisor, admin |
| `POST /conversations/{id}/handoff`          | `conversation:claim` | agent, supervisor, admin |

`ai:read` and `ai:write` are **admin-only** under the shipped `ROLE_PERMISSIONS` matrix.
TAR-28 added no permission and moved no grant: knowledge-base content is tenant-authored
business material, and widening it to agents is ADR 0004's call.

**The handoff pair is `conversation:*` rather than `ai:*` on purpose.** The agent reading the
summary and taking the thread is exactly who those routes exist for, and `ai:read` would shut
them out. `HandoffService` applies the inbox's own visibility check on top, so a conversation
the principal may not see answers `not_found` either way.

## The plan gate

The chatbot is gated on the `ai_chatbot` plan feature (`PlanFeaturesService`). The gate is on
the **writes only**, and the asymmetry is deliberate:

| Route                                       | Plan lacks `ai_chatbot`                                   |
| ------------------------------------------- | --------------------------------------------------------- |
| `GET /ai/config`                            | `200`, with `feature_not_in_plan` in `readiness.blockers` |
| `PATCH /ai/config`                          | `403 feature_not_in_plan`                                 |
| `GET /knowledge-documents`, `GET …/{id}`    | `200`                                                     |
| `POST`, `PATCH`, `POST …/reindex`, `DELETE` | `403 feature_not_in_plan`                                 |

A tenant whose plan does not include the chatbot must be able to see the knowledge base they
already authored and be shown an upsell rather than a 403 page — which is why the console can
render `/settings/chatbot` at all without the feature.

`PlanFeaturesService.includes` is checked as `includes === false`, so a plan whose
entitlements say nothing about `ai_chatbot` passes. Every tenant today is in that state.

> **TODO(author):** `KnowledgeDocumentService.delete` is inside the same write gate, so a
> tenant whose plan explicitly excludes `ai_chatbot` cannot delete the knowledge base they
> authored under a plan that did. The service comment names this as the conservative reading
> and offers moving `delete` out of the gate as a one-line change. Which behaviour does
> product want, and which story owns the decision?

## Idempotency

No route on this surface requires an `Idempotency-Key`, and each has its own reason:

- **`POST /knowledge-documents`** — ADR 0002 requires the header on sends and billing
  operations. A duplicate knowledge-base document is a visible, editable row an admin can
  delete, not a message a customer received twice.
- **`PATCH /ai/config`** — a `PATCH` of named fields to fixed values is idempotent by
  construction.
- **`POST /conversations/{id}/handoff`** — idempotent by design. A conversation already
  `handed_off` or `human_active`, or one the chatbot never touched, answers `200` with the
  current conversation and writes nothing.

The one place idempotency matters is the path with no HTTP request in it: a bot turn. The
guard is a row, not a queue property — `bot_turns` is claimed on
`(tenant_id, inbound_message_id)` **before** the model call, so a worker that crashes after
sending cannot send twice on retry. See [What happens on an inbound message](#what-happens-on-an-inbound-message).

## The empty-knowledge-base guarantee

**A tenant with no indexed knowledge base cannot receive an automated reply, and the
guarantee is structural rather than behavioural** (TAR-28 AC3).

Two independent gates make it so, and neither is a prompt instruction:

1. `BotEligibilityService.decideEligibility` refuses the turn before a prompt exists when the
   tenant has no provider key, no plan feature, the chatbot switched off, or nothing indexed.
   The refusal is silent: no reply, no `handoff_events` row, no customer-visible change.
2. `KnowledgeRetrieverService` returns nothing when no chunk clears `BOT_CONFIDENCE.rankFloor`,
   and a turn with zero retrieved chunks **never calls the model** — it becomes
   `handoff:no_match`.

There is no code path on which the model is invoked without that tenant's own knowledge-base
content in the prompt. Lexical retrieval was chosen partly for this: a rank with a floor can
say "nothing here answers this", where cosine similarity over embeddings gives a number that
is never zero and would make the floor a tuning exercise rather than a rule.

`GET /ai/config` publishes this as `readiness`, so a console can explain silence rather than
showing a switch that looks on.

## What happens on an inbound message

`TicketQueueRunner` enqueues `ai.handle-inbound` on the `ai` queue after the ticket-linking
transaction commits. `BotTurnService.handle` then runs one turn:

1. **Gate** (`decideEligibility`, a pure function over a snapshot). Refuses in this order:
   `provider_not_configured`, `feature_not_in_plan`, `disabled`, `no_knowledge_base`,
   `unreadable`, `opted_out`, `not_inbound`, `empty_message`, `already_released`,
   `window_closed`. All are `suppressed`. `max_turns` is the exception — it is a **handoff**,
   because the customer is mid-conversation and silence would strand them.
2. **Keyword** (`matchHandoffKeyword`). The cheapest gate and the highest-priority one: a
   message containing one of the tenant's `handoffKeywords` hands off as
   `customer_requested` without a retrieval query or a token spent.
3. **Retrieve** (`KnowledgeRetrieverService`). `websearch_to_tsquery` over the generated
   `search_vector`, ranked by `ts_rank_cd`; a `pg_trgm` `word_similarity` pass runs as a
   second retriever only when full-text search returns nothing. Zero chunks above the floor →
   `handoff:no_match`, model never called.
4. **Model** (`ClaudeClient`). At most `BOT_CONFIDENCE.topK` chunks in the prompt, plus
   `CONVERSATION_HISTORY_TURNS` prior messages, bounded by `CLAUDE_TIMEOUT_MS` and
   `CLAUDE_MAX_TOKENS`.
5. **Score.** `min(modelConfidence, retrievalConfidence)`, plus two hard preconditions
   outside the score: every cited chunk id must be one this turn retrieved, and there must be
   at least one.
6. **Reply or hand off.** Below `minConfidence` → `handoff:low_confidence`. A timeout,
   refusal, `max_tokens` stop, malformed output or provider failure → `handoff:bot_error`.

Every branch records exactly one `bot_turns` outcome — `replied`, `handed_off` or
`suppressed` — and **there is no path on which the customer is left with silence and no
human**.

**A successful reply moves the ticket to `pending` and enqueues `sla.evaluate-ticket`.**
`SlaTimerService` stops a first-response timer on an outbound message with a non-null sender,
and a bot reply has none — so without the status change every conversation the chatbot handled
perfectly would still breach and page a supervisor. The enqueue is what makes the pause take
effect now rather than at the next breach sweep.

### Why `min` and not an average

An average lets a confident model compensate for weak retrieval, which is precisely the
hallucination case this feature exists to prevent. Under `min` neither signal rescues the
other: the chatbot answers only when the material was there **and** the model says it used it.
The result stays monotone in both inputs, so `minConfidence` keeps a meaning an admin can
hold in their head.

`compositeConfidence` and `retrievalConfidence` are exported from
`packages/contracts/src/ai.ts` so the worker, the console and the tests read one copy.

### The scoring constants

`BOT_CONFIDENCE`, in `packages/contracts/src/ai.ts`. **Defensible starting values, not
measured ones** — `bot_turns` stores `model_confidence` and `retrieval_score` separately so
re-tuning them is a query rather than a re-derivation from an aggregate.

| Constant          | Value                            | What it decides                                                 |
| ----------------- | -------------------------------- | --------------------------------------------------------------- |
| `modelConfidence` | `high: 1, medium: 0.6, low: 0.3` | The model's own reported level, as a number                     |
| `rankTarget`      | `0.1`                            | The `ts_rank_cd` value that counts as full retrieval confidence |
| `rankFloor`       | `0.01`                           | Below this a chunk is not retrieved at all                      |
| `trigramFloor`    | `0.3`                            | What a chunk must reach on the fallback retriever               |
| `topK`            | `6`                              | Chunks put in the prompt, at most                               |

### The conversation state machine

`conversations.bot_state`, published as `ConversationResponse.botState`:

| State          | Means                                                    |
| -------------- | -------------------------------------------------------- |
| `off`          | The chatbot has never engaged this conversation          |
| `bot_active`   | The chatbot is answering                                 |
| `handed_off`   | The chatbot gave up, and nobody has taken the thread yet |
| `human_active` | A person is on it, and the chatbot will not resume       |

`human_active` and `handed_off` are terminal for the chatbot: neither has a transition back to
`bot_active`. A bot that resumed after an agent had spoken would talk over a colleague in
front of the customer, and no confidence score prevents that. Resolving or closing the
conversation resets the state to `off`, which is what stops one handoff disabling the chatbot
for that contact for ever.

`ConversationResponse.botHandling` is still published and still means
`botState === 'bot_active'`. It cannot distinguish a conversation the chatbot never touched
from one it gave up on, which is why `botState` exists.

`messages.origin` does the same job one level down: `origin === 'bot'` is what lets a client
name the chatbot rather than automation in general, since a workflow reply (TAR-27) is also
sent automatically.

## Chatbot configuration

A singleton resource — one row per tenant — so there is no id in the path and no list.

**A tenant with no `ai_configs` row reads defaults rather than a `404`.** The row is created
on first write; until then `GET` answers with the column defaults, `isEnabled: false` and
`updatedAt` at the Unix epoch.

| Field             | Type                     | Default | Notes                                                                |
| ----------------- | ------------------------ | ------- | -------------------------------------------------------------------- |
| `isEnabled`       | boolean                  | `false` | Off by default                                                       |
| `model`           | `AiModel \| null`        | `null`  | `null` = the platform default, `claude-opus-5`                       |
| `systemPrompt`    | string ≤ 4000 \| null    | `null`  | Tone and house rules. Never overrides the knowledge base             |
| `handoffKeywords` | string[] ≤ 50, each ≤ 64 | `[]`    | Matched before retrieval — see [Keyword matching](#keyword-matching) |
| `minConfidence`   | number 0–1               | `0.6`   | The floor the composite score must reach to reply                    |
| `maxBotTurns`     | integer 1–20             | `5`     | Replies allowed in one engagement before `handoff:max_turns`         |
| `handoffMessage`  | string ≤ 1000 \| null    | `null`  | Sent once per conversation on handoff. `null` = say nothing          |

The bounds are enforced twice on purpose: zod guards the one handler that writes this row
today, and the CHECK constraints TAR-402 shipped guard every writer there will ever be.

`model` is **free text in the database and an allowlist at the boundary** — `AI_MODELS` in
the contract. A CHECK would make adding a model id a migration, and model ids change on the
provider's schedule rather than ours.

### `GET /api/v1/ai/config`

The configuration, the readiness breakdown and the model catalogue.

**Authentication.** Session cookie plus `ai:read`. Absent, `401 unauthenticated`.

**Not plan-gated.** A tenant without `ai_chatbot` reads it with the blocker named.

```bash
curl https://acme.app.example.com/api/v1/ai/config \
  -H "Cookie: wac_session=$SESSION"
```

```json
{
  "isEnabled": true,
  "model": null,
  "systemPrompt": "Answer in the customer's language. Never quote a price.",
  "handoffKeywords": ["agent", "human", "مندوب"],
  "minConfidence": 0.6,
  "maxBotTurns": 5,
  "handoffMessage": "One moment — I'm passing you to a colleague.",
  "readiness": {
    "ready": true,
    "indexedDocumentCount": 14,
    "blockers": []
  },
  "availableModels": [
    {
      "id": "claude-opus-5",
      "displayName": "Claude Opus 5",
      "inputPricePerMTokUsd": 5,
      "outputPricePerMTokUsd": 25,
      "isDefault": true
    }
  ],
  "updatedAt": "2026-08-20T14:31:07.412Z"
}
```

| Status | Code              | Cause                            |
| ------ | ----------------- | -------------------------------- |
| `200`  | —                 |                                  |
| `401`  | `unauthenticated` | No session, or an expired one    |
| `403`  | `forbidden`       | The role does not hold `ai:read` |

`availableModels` is trimmed above; the response carries all three of `AI_MODEL_CATALOG`.

> **TODO(author):** `AI_MODEL_CATALOG`'s prices are list prices at the time of writing, and
> ADR 0010 decision 10 records that they need re-verification before they are shown to a
> paying tenant. The console renders them today. Which story owns that verification?

#### `readiness`

Computed on every read, never stored. Caching it would be an answer that keeps saying
`ready` after a tenant deleted their last document, which is exactly the state AC3 exists to
make impossible.

`blockers` lists **every** failing clause rather than the first, because a tenant with no
plan and no documents has two things to fix.

| Blocker                   | Means                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| `provider_not_configured` | `ANTHROPIC_API_KEY` is unset on this deployment. Platform-level, not tenant-level |
| `feature_not_in_plan`     | The tenant's plan does not include `ai_chatbot`                                   |
| `disabled`                | `isEnabled` is false                                                              |
| `no_indexed_documents`    | No document is `indexed`, or no chunk exists                                      |

`indexedDocumentCount` and the chunk check are separate facts: a document can be marked
`indexed` with zero chunks if its content was whitespace. The blocker names the document
count because that is what an admin can act on.

### `PATCH /api/v1/ai/config`

Updates named fields. `upsert` on `tenant_id`, so the first edit creates the row.

**Authentication.** Session cookie plus `ai:write`, **and** the `ai_chatbot` plan feature.

**Idempotency.** Replaying the same body writes the same values. No header required.

| Parameter         | In   | Type              | Required | Default   | Notes                              |
| ----------------- | ---- | ----------------- | -------- | --------- | ---------------------------------- |
| `isEnabled`       | body | boolean           | no       | unchanged |                                    |
| `model`           | body | `AiModel \| null` | no       | unchanged | One of `AI_MODELS`, or `null`      |
| `systemPrompt`    | body | string \| null    | no       | unchanged | ≤ 4000 characters                  |
| `handoffKeywords` | body | string[]          | no       | unchanged | ≤ 50 entries, each 1–64 characters |
| `minConfidence`   | body | number            | no       | unchanged | 0–1                                |
| `maxBotTurns`     | body | integer           | no       | unchanged | 1–20                               |
| `handoffMessage`  | body | string \| null    | no       | unchanged | ≤ 1000 characters                  |

```bash
curl -X PATCH https://acme.app.example.com/api/v1/ai/config \
  -H "Cookie: wac_session=$SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"isEnabled":true,"minConfidence":0.75,"handoffKeywords":["agent","human"]}'
```

The response is the full `GET` shape, with `readiness` recomputed — so enabling the chatbot
with an empty knowledge base answers `200` with `ready: false` and `no_indexed_documents`
still in `blockers`. That is the honest answer: the switch is on and nothing will be
answered.

| Status | Code                  | Cause                                                        |
| ------ | --------------------- | ------------------------------------------------------------ |
| `200`  | —                     |                                                              |
| `400`  | `validation_failed`   | A field outside its bounds, or a `model` outside `AI_MODELS` |
| `401`  | `unauthenticated`     | No session, or an expired one                                |
| `403`  | `forbidden`           | The role does not hold `ai:write`                            |
| `403`  | `feature_not_in_plan` | The tenant's plan does not include `ai_chatbot`              |

### Keyword matching

`handoffKeywords` are matched by `matchHandoffKeyword`, and the rule is specified rather than
left to the implementation: **NFKC normalised, case-folded, nonspacing marks and the tatweel
(`U+0640`) stripped, whitespace runs collapsed, then a substring match of any keyword against
the normalised message.** Both sides go through the same normalisation.

**Substring, not whole-word.** `agent` has to match `agent?` and `…an agent!`, and Arabic is
not reliably whitespace-token separable for this purpose — a definite article or a
conjunction attaches to the word it qualifies, so a whole-word rule would miss exactly the
phrasing a customer is most likely to use. The cost is stated rather than hidden: a short
keyword can match inside an unrelated word. `handoffKeywords` is tenant-authored, and the
console is where a bad keyword gets fixed.

An empty or whitespace-only keyword never matches.

## Knowledge base

A **knowledge document** is one piece of tenant-authored material the chatbot may answer
from. It is written, not uploaded: `content` is plain text, and **a blank line is a chunk
boundary**.

### Indexing is asynchronous, in exactly one respect

A `POST`, and a `PATCH` that changes `content`, answer with `status: 'pending'` and enqueue
`ai.index-document`. **The document is not retrievable by the chatbot until indexing
commits.** Returning it as `indexed` and chunking inline would put a paragraph-splitting pass
over 256 KiB inside a request, and would make a failed chunking run a failed save of content
the tenant had already written.

`chunkDocument` packs paragraphs to roughly `CHUNKING.targetChars` (1200) with
`CHUNKING.overlapParagraphs` (1) carried into the next chunk, so a sentence answered across a
paragraph boundary is retrievable from either side. A single paragraph longer than
`CHUNKING.hardLimit` (2000) is split on whitespace — the one place the author's own boundary
is overridden.

| `status`  | Means                                                          |
| --------- | -------------------------------------------------------------- |
| `pending` | Queued or being chunked. The chatbot cannot retrieve it        |
| `indexed` | Chunked. The chatbot may retrieve and cite it                  |
| `failed`  | Chunking failed; `indexError` says why. The chatbot ignores it |

Reindexing is delete-and-insert in one transaction keyed on the document, so a retrieval
running alongside an edit sees the old chunk set or the new one, never a mixture — a
partially reindexed document is exactly a confidently wrong answer.

**Only a content change reindexes.** Renaming a document or correcting its source URL leaves
the chunks alone, because neither reaches the search vector.

**Nothing re-enqueues a lost indexing job.** `QueueService.enqueue` never throws, so a Redis
outage leaves a committed document parked at `pending` with a logged warning.
`POST …/{id}/reindex` is the repair, and `readiness.indexedDocumentCount` is what makes the
gap visible.

### The limits

`KNOWLEDGE_DOCUMENT_LIMITS`, in `packages/contracts/src/ai.ts`.

| Limit                | Value              | Exceeding it                              |
| -------------------- | ------------------ | ----------------------------------------- |
| `contentBytes`       | `262144` (256 KiB) | `400 validation_failed`, naming the limit |
| `titleLength`        | `200` characters   | `400 validation_failed`                   |
| `sourceUrlLength`    | `2048` characters  | `400 validation_failed`                   |
| `documentsPerTenant` | `1000`             | `409 conflict`                            |

`contentBytes` is counted in **UTF-8 bytes**, as the name says — not in UTF-16 code units,
which would accept roughly twice this much Arabic or Chinese and make one published number
mean different things in different languages.

The per-tenant cap is `conflict` rather than `plan_limit_exceeded` because it is a platform
bound on how large a knowledge base may get, not something a plan sells more of — reporting
it as a billing refusal would send an admin to a pricing page that cannot help them. It is
checked inside the insert transaction; the honest limitation is that two transactions
interleaving under read-committed can still land at 1001. That is accepted: the cap exists so
a knowledge base has a size answer, not as a billing boundary.

`payload_too_large` is a different and coarser failure — the API's JSON body limit, which
`configureApp` sets above `contentBytes` precisely so a document at the documented size is
accepted rather than rejected by the parser.

### `GET /api/v1/knowledge-documents`

Lists documents, newest first, **without `content`**. A page of 1000 documents carrying
256 KiB each is a response nobody wants; the full document is the single read.

**Authentication.** Session cookie plus `ai:read`. Not plan-gated.

| Parameter | In    | Type    | Required | Default | Notes                                                   |
| --------- | ----- | ------- | -------- | ------- | ------------------------------------------------------- |
| `cursor`  | query | string  | no       | —       | Opaque. From a previous `nextCursor`                    |
| `limit`   | query | integer | no       | `25`    | 1–100                                                   |
| `status`  | query | enum    | no       | —       | `pending`, `indexed` or `failed`                        |
| `q`       | query | string  | no       | —       | Case-insensitive substring of `title`, 1–120 characters |

**`q` is a console filter over titles, not the retrieval path.** Retrieval runs over chunks
in `KnowledgeRetrieverService` and is not reachable through this API. `q` is unindexed and
accepted as such: a tenant holds at most 1000 documents by construction.

```bash
curl 'https://acme.app.example.com/api/v1/knowledge-documents?status=indexed&limit=2' \
  -H "Cookie: wac_session=$SESSION"
```

```json
{
  "items": [
    {
      "id": "019fed83-ebd1-774d-86e4-46137546a539",
      "title": "Returns and refunds policy",
      "sourceUrl": "https://acme.example.com/returns",
      "language": "en",
      "status": "indexed",
      "chunkCount": 14,
      "indexError": null,
      "indexedAt": "2026-08-20T14:22:03.918Z",
      "createdAt": "2026-08-20T14:21:58.204Z",
      "updatedAt": "2026-08-20T14:22:03.918Z"
    }
  ],
  "nextCursor": "eyJhdCI6IjIwMjYtMDgtMjBUMTQ6MjE6NTguMjA0WiIsImlkIjoiMDE5..."
}
```

| Status | Code                | Cause                                         |
| ------ | ------------------- | --------------------------------------------- |
| `200`  | —                   |                                               |
| `400`  | `validation_failed` | A malformed `cursor`, or `limit` out of range |
| `401`  | `unauthenticated`   | No session, or an expired one                 |
| `403`  | `forbidden`         | The role does not hold `ai:read`              |

### `GET /api/v1/knowledge-documents/{id}`

One document, **with** `content`. This is the read an editor makes before opening an entry.

**Authentication.** Session cookie plus `ai:read`. Not plan-gated.

| Status | Code                | Cause                                                  |
| ------ | ------------------- | ------------------------------------------------------ |
| `200`  | —                   |                                                        |
| `400`  | `validation_failed` | `id` is not a UUID                                     |
| `401`  | `unauthenticated`   | No session, or an expired one                          |
| `403`  | `forbidden`         | The role does not hold `ai:read`                       |
| `404`  | `not_found`         | No such document — **or it belongs to another tenant** |

An unknown id and another tenant's are the same `not_found`. A `403` on the second would
confirm the id names a real row somewhere.

### `POST /api/v1/knowledge-documents`

Creates a document. Answers `201` with `status: 'pending'`.

**Authentication.** Session cookie plus `ai:write`, **and** the `ai_chatbot` plan feature.

**Idempotency.** No header. A replay creates a second document.

| Parameter   | In   | Type   | Required | Default | Notes                                                           |
| ----------- | ---- | ------ | -------- | ------- | --------------------------------------------------------------- |
| `title`     | body | string | yes      | —       | 1–200 characters                                                |
| `content`   | body | string | yes      | —       | 1 character to 256 KiB of UTF-8. Blank line = chunk boundary    |
| `sourceUrl` | body | string | no       | `null`  | A full URL, ≤ 2048 characters. Nullable on `PATCH`, to clear it |
| `language`  | body | string | no       | `null`  | BCP 47. Stored for the console; **not** consulted by retrieval  |

```bash
curl -X POST https://acme.app.example.com/api/v1/knowledge-documents \
  -H "Cookie: wac_session=$SESSION" \
  -H 'Content-Type: application/json' \
  -d '{
        "title": "Returns and refunds policy",
        "content": "Unopened items can be returned within 30 days of delivery for a full refund.\n\nOpened items can be returned within 14 days if the packaging is intact.",
        "sourceUrl": "https://acme.example.com/returns",
        "language": "en"
      }'
```

```json
{
  "id": "019fed83-ebd1-774d-86e4-46137546a539",
  "title": "Returns and refunds policy",
  "sourceUrl": "https://acme.example.com/returns",
  "content": "Unopened items can be returned within 30 days of delivery for a full refund.\n\nOpened items can be returned within 14 days if the packaging is intact.",
  "language": "en",
  "status": "pending",
  "chunkCount": 0,
  "indexError": null,
  "indexedAt": null,
  "createdAt": "2026-08-20T14:21:58.204Z",
  "updatedAt": "2026-08-20T14:21:58.204Z"
}
```

| Status | Code                  | Cause                                                 |
| ------ | --------------------- | ----------------------------------------------------- |
| `201`  | —                     |                                                       |
| `400`  | `validation_failed`   | A field outside its bounds, or `content` over 256 KiB |
| `401`  | `unauthenticated`     | No session, or an expired one                         |
| `403`  | `forbidden`           | The role does not hold `ai:write`                     |
| `403`  | `feature_not_in_plan` | The tenant's plan does not include `ai_chatbot`       |
| `409`  | `conflict`            | The tenant already holds 1000 documents               |
| `413`  | `payload_too_large`   | The body exceeded the API's JSON limit before parsing |

**`language` does not reach retrieval.** The search vector is a generated column built with
the `'simple'` configuration, which forces a literal, so a per-document `regconfig` cannot
reach the query at all. The column is stored for the console and for a future per-language
partial index.

### `PATCH /api/v1/knowledge-documents/{id}`

A partial edit. Every field is optional; omitted fields are unchanged.

**Authentication.** Session cookie plus `ai:write`, **and** the `ai_chatbot` plan feature.

**Idempotency.** Replaying the same body writes the same values — but a body containing
`content` reindexes each time.

Parameters are the create's, all optional. Sending `content` sets `status` back to `pending`
and clears `indexError`: the chunks on disk describe content that no longer exists, and
leaving the row `indexed` would let the chatbot cite the old text against the new document
until the job ran.

`sourceUrl` is the one parameter that accepts more than the create's: it is **nullable here**,
and `"sourceUrl": null` clears a stored link. Omitting the key leaves it alone, which is what
every other field's absence means — so without the null there was no way to say "there is no
source URL any more", and a console that cleared the field saved no change at all.

| Status | Code                  | Cause                                                |
| ------ | --------------------- | ---------------------------------------------------- |
| `200`  | —                     |                                                      |
| `400`  | `validation_failed`   | `id` is not a UUID, or a field is outside its bounds |
| `401`  | `unauthenticated`     | No session, or an expired one                        |
| `403`  | `forbidden`           | The role does not hold `ai:write`                    |
| `403`  | `feature_not_in_plan` | The tenant's plan does not include `ai_chatbot`      |
| `404`  | `not_found`           | No such document, or it belongs to another tenant    |

### `POST /api/v1/knowledge-documents/{id}/reindex`

Requeues chunking. Answers `202` with `status: 'pending'` and `indexError` cleared — the work
has been accepted rather than done.

The repair for a document parked `failed`, and the way to pick up a chunking change without
rewriting content.

**Authentication.** Session cookie plus `ai:write`, **and** the `ai_chatbot` plan feature.

**Idempotency.** Safe to replay. A re-enqueue of the same document collapses while the first
job is still queued (`indexKnowledgeDocumentJobId`).

```bash
curl -X POST \
  https://acme.app.example.com/api/v1/knowledge-documents/019fed83-ebd1-774d-86e4-46137546a539/reindex \
  -H "Cookie: wac_session=$SESSION"
```

| Status | Code                  | Cause                                             |
| ------ | --------------------- | ------------------------------------------------- |
| `202`  | —                     |                                                   |
| `400`  | `validation_failed`   | `id` is not a UUID                                |
| `401`  | `unauthenticated`     | No session, or an expired one                     |
| `403`  | `forbidden`           | The role does not hold `ai:write`                 |
| `403`  | `feature_not_in_plan` | The tenant's plan does not include `ai_chatbot`   |
| `404`  | `not_found`           | No such document, or it belongs to another tenant |

### `DELETE /api/v1/knowledge-documents/{id}`

Deletes a document and, through the composite foreign key's cascade, its chunks — so the
chatbot cannot cite content a tenant has removed, and there is no second delete to remember.

**Authentication.** Session cookie plus `ai:write`, **and** the `ai_chatbot` plan feature.

**Idempotency.** Not safe to replay: a second delete of the same id answers `404`.

| Status | Code                  | Cause                                             |
| ------ | --------------------- | ------------------------------------------------- |
| `204`  | —                     | No body                                           |
| `400`  | `validation_failed`   | `id` is not a UUID                                |
| `401`  | `unauthenticated`     | No session, or an expired one                     |
| `403`  | `forbidden`           | The role does not hold `ai:write`                 |
| `403`  | `feature_not_in_plan` | The tenant's plan does not include `ai_chatbot`   |
| `404`  | `not_found`           | No such document, or it belongs to another tenant |

Deleting the last `indexed` document switches automated replies off on the next read:
`readiness` is recomputed per request, so `no_indexed_documents` appears immediately.

## Handoff

A **handoff** here is the chatbot releasing a conversation to a human. It is not TAR-473's
ticket handoff between two agents, and it does not reassign anything by itself.

Every refusal after the chatbot has engaged ends with a human. All six reasons write a
`handoff_events` row, move `bot_state` to `handed_off` and re-request routing when nobody
holds the ticket:

| Reason               | Cause                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| `low_confidence`     | The composite score fell below the tenant's `minConfidence`             |
| `no_match`           | Retrieval returned nothing above the floor; the model was never called  |
| `customer_requested` | A `handoffKeywords` entry matched                                       |
| `max_turns`          | `maxBotTurns` reached in this engagement                                |
| `agent_requested`    | An agent took the thread from the console                               |
| `bot_error`          | Timeout, refusal, `max_tokens` stop, malformed output, provider failure |

**Routing is re-requested only when nobody holds the ticket** — `routing_state` `pending` or
`deferred`, never `assigned` or `manual`, which would step over ADR 0007's rule that a human
placement is terminal. Routing may already have placed the ticket with an agent before the
chatbot said anything, which is what makes a handoff instant rather than the start of a wait.

`handoffMessage`, when set, is sent to the customer once per conversation. It is once without
a second counter because `handed_off` is terminal for the chatbot.

#### The exception: an unanswerable opener is not a handoff

`no_match` and `low_confidence` on a conversation the chatbot has **never spoken in** are
recorded as `suppressed` with the reason `no_answer_unengaged`, not as a handoff: no
`handoff_events` row, no `handoffMessage`, no `bot_state` move, no routing re-request. The
conversation stays `off` and the next message is gated afresh.

The reason is TAR-28 AC1. `handed_off` carries two different facts — _a human has been asked
for_, and _the chatbot could not help_ — and only the first should be terminal. An opening
"hi" that misses the knowledge base is the second, and treating it as the first left the real
question, arriving one message later, ineligible to be answered.

Nobody is stranded by the silence: the ticket exists, routing already ran on ticket creation,
and the SLA clock is still running because only a _successful reply_ pauses it. An
unanswerable opening question is a live, routed, clocked ticket with the breach sweep as the
backstop.

### `GET /api/v1/conversations/{id}/handoff`

The most recent handoff on a conversation.

**Authentication.** Session cookie plus `conversation:read`, and the inbox's own visibility
check on top.

**This is deliberately not a transcript.** The chatbot's replies are ordinary `messages` rows
— genuinely sent to the customer over WhatsApp — so the agent's existing thread view already
holds the whole exchange, verbatim and in order. This response carries what the thread
cannot: why the chatbot stopped, how sure it was, and which documents it drew on.

`citedDocuments` is the field that earns its place: it is what lets an agent see the chatbot
answered from the _refunds_ policy when the customer asked about _shipping_, which is the most
common shape of a confident wrong answer and is invisible from the transcript alone.

```bash
curl https://acme.app.example.com/api/v1/conversations/019fed70-2c11-7a3e-9b04-1d2f5c8ea701/handoff \
  -H "Cookie: wac_session=$SESSION"
```

```json
{
  "conversationId": "019fed70-2c11-7a3e-9b04-1d2f5c8ea701",
  "ticketId": "019fed70-3a88-7c19-b5d2-6e4419a2f0c3",
  "reason": "low_confidence",
  "triggerMessageId": "019fed72-9d40-7f61-8a77-2b90c4e15d18",
  "triggerMessageBody": "Can I get my money back if I opened the box?",
  "botExchange": [],
  "botEngagedAt": "2026-08-20T15:02:11.004Z",
  "handedOffAt": "2026-08-20T15:04:47.331Z",
  "botReplyCount": 2,
  "confidence": {
    "score": 0.42,
    "modelConfidence": 0.6,
    "retrievalScore": 0.42,
    "modelReason": "ambiguous"
  },
  "citedDocuments": [
    { "id": "019fed83-ebd1-774d-86e4-46137546a539", "title": "Returns and refunds policy" }
  ]
}
```

`botExchange` is elided above; it carries every message whose `sentAt` falls between
`botEngagedAt` and the handoff, inclusive, oldest first, in `MessageResponse` shape.

| Field                | Nullable | When it is null                                                                       |
| -------------------- | -------- | ------------------------------------------------------------------------------------- |
| `ticketId`           | yes      | The linker produced no ticket for the triggering message                              |
| `botEngagedAt`       | yes      | The chatbot never reached the model — `no_match`, or a keyword match before any reply |
| `confidence`         | yes      | The same cases: there is no scored turn to point at                                   |
| `triggerMessageBody` | yes      | The triggering message carried no text                                                |

| Status | Code                | Cause                                                                |
| ------ | ------------------- | -------------------------------------------------------------------- |
| `200`  | —                   |                                                                      |
| `400`  | `validation_failed` | `id` is not a UUID                                                   |
| `401`  | `unauthenticated`   | No session, or an expired one                                        |
| `403`  | `forbidden`         | The role does not hold `conversation:read`                           |
| `404`  | `not_found`         | No handoff on that conversation, **or** the principal may not see it |

The two `404` causes are one answer on purpose. Answering `404` for the first and `403` for
the second would tell a caller which conversation ids are real.

A conversation can be resolved, reopened by a later question, handled by the chatbot again
and handed off again, so `handoff_events` is deliberately not unique per conversation. This
route returns the most recent row.

### `POST /api/v1/conversations/{id}/handoff`

An agent taking a bot-active thread. Records `agent_requested` and moves the conversation to
`human_active`.

**Authentication.** Session cookie plus `conversation:claim` — **every role holds it**.
Taking a thread from the chatbot is the same act as taking one out of the shared pool.

**Idempotency.** A conversation already `handed_off` or `human_active`, or one the chatbot
never touched, answers `200` with the current conversation and writes nothing. A double-click
is a no-op, not a `409`.

The body is empty and `.strict()`, so a client that sends a `reason` is told so rather than
having it silently ignored — the reason is always `agent_requested`.

```bash
curl -X POST \
  https://acme.app.example.com/api/v1/conversations/019fed70-2c11-7a3e-9b04-1d2f5c8ea701/handoff \
  -H "Cookie: wac_session=$SESSION" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

The response is the full `ConversationResponse`, with `botState: "human_active"`.

| Status | Code                | Cause                                                 |
| ------ | ------------------- | ----------------------------------------------------- |
| `200`  | —                   |                                                       |
| `400`  | `validation_failed` | `id` is not a UUID, or the body carried a field       |
| `401`  | `unauthenticated`   | No session, or an expired one                         |
| `403`  | `forbidden`         | The role does not hold `conversation:claim`           |
| `404`  | `not_found`         | No such conversation, or the principal may not see it |

`HandoffService.record` compare-and-sets on `bot_state <> 'human_active'`, which closes the
window between the eligibility gate and the write: an agent can claim the thread while the
model is thinking, and the chatbot must not take it back.

## Tenant isolation

Every table this surface reads or writes is tenant-scoped, and every query goes through
`TenantPrisma` so row-level security (RLS) supplies `tenant_id`. There is no `tenantId`
filter in `apps/api/src/ai/` except the one a create needs as a column value, and the one
`KnowledgeRetrieverService` passes for the query planner.

**That last one is a plan fix, not a second isolation layer.** A non-leakproof RLS qual
cannot be pushed into an index condition, so the planner would otherwise filter after the
scan — the same documented exception the inbox query already takes. See
[the tenant isolation contract](tenancy.md).

`pnpm db:verify:rls` asserts structurally over **every** table carrying `tenant_id`, so all
five tables TAR-402 added — `ai_configs`, `knowledge_documents`, `knowledge_chunks`,
`bot_turns` and `handoff_events` — are covered without being named in it.
`apps/api/src/prisma/ai-chatbot-schema.int-spec.ts` is the two-tenant case for this surface
specifically.

## Configuration

| Variable            | Scope    | Effect when unset                                                                                                        |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY` | Platform | No tenant gets automated replies. `readiness.blockers` carries `provider_not_configured`, and no path calls the provider |

One platform key serves every tenant. Per-tenant bring-your-own keys are deferred; tenant
scoping is the knowledge base and the `ai_configs` row, never a per-tenant secret.

Worker and client tuning that is **not** part of the published contract lives in
`apps/api/src/ai/ai.constants.ts`: `AI_WORKER_CONCURRENCY` (4), `AI_TURN_MAX_ATTEMPTS` (2),
`AI_INDEX_MAX_ATTEMPTS` (3), `CLAUDE_TIMEOUT_MS` (20000), `CLAUDE_MAX_TOKENS` (4096),
`BOT_REPLY_MAX_CHARS` (1200) and `CONVERSATION_HISTORY_TURNS` (6). All are stated in ADR 0010
and none is measured.

The turn retry budget is deliberately small: a `bot_turns` row is inserted before the model
call, so a retry arriving after a successful send is refused by the unique constraint rather
than sending twice — but a customer waiting on an answer is not helped by a fifth attempt two
minutes later, and the honest fallback is a human.

## What this surface does not do

Stated rather than left to be discovered:

- **No knowledge-base search endpoint.** Retrieval is internal to the turn. `q` on the list
  is a title filter.
- **No embeddings, and no `pgvector`.** Retrieval is lexical. The revisit signal ADR 0010
  names is the `no_match` share of `bot_turns`, which the `(tenant_id, outcome, created_at)`
  index serves.
- **No file or URL import.** `sourceUrl` is a link for the tenant's own team; nothing fetches
  it.
- **No per-tenant provider key**, and no per-tenant spend cap. `bot_turns` records
  `input_tokens`, `output_tokens` and `cached_input_tokens` per turn, but nothing reads them
  back as a bill.
- **No bot-turn or handoff analytics endpoint.** The tuning queries are SQL against
  `bot_turns` today.
