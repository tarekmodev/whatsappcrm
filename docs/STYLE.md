# Documentation style guide

How documentation in this repository is written. Read this before adding or editing a
file under `docs/`, and before rewriting a section of `README.md`.

If you need to deviate, change this file in the same pull request. A convention that is
quietly ignored is worse than one that was never written down.

## Decide the reader first

Every document names one reader and holds it to the end. The two readers here are not
the same person and must never be averaged into one:

| Reader                              | Assumes                                                                       | Never contains                                  |
| ----------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------- |
| **Engineer**                        | TypeScript, SQL, HTTP and the stack in [ADR 0001](adr/0001-stack-decision.md) | Explanations of general programming concepts    |
| **Platform operator**               | Runs the platform, reads a terminal, does not read this codebase              | Prisma internals, module names, type signatures |
| **Tenant user** (agent, supervisor) | Nothing technical. Refers to buttons by their visible labels                  | Any implementation vocabulary at all            |

State the reader in the opening paragraph when it is not obvious from the path. When one
subject serves two readers, split it into two documents or two clearly labelled sections
— never one blended paragraph.

Nothing under `docs/reference/` targets a tenant user. Tenant-user documentation lives in
`docs/guides/` and started with
[Change a ticket's status and priority](guides/manage-ticket-status-and-priority.md)
(TAR-295), once TAR-286 shipped a console surface worth describing;
[Route new tickets to the right team](guides/route-new-tickets-with-rules.md) (TAR-292) is
the second, [Clear tickets nobody could take](guides/clear-flagged-tickets.md) (TAR-277) the
third, [Watch tickets that miss their deadline](guides/track-overdue-tickets.md) (TAR-287) the
fourth and [Read the performance dashboard](guides/read-the-performance-dashboard.md) (TAR-434)
the fifth. [Put your own brand on the workspace](guides/brand-your-workspace.md) and
[Serve the workspace from your own web address](guides/set-up-a-custom-domain.md) (both
TAR-423) are the sixth and seventh, and the first pair written for a workspace **admin**
rather than a supervisor.
[Hand a ticket on, or ask a supervisor](guides/hand-over-or-escalate-a-ticket.md) (TAR-473) is
the eighth, and the first written for an **agent** rather than a supervisor or an admin.
[Answer common questions with saved replies](guides/use-saved-replies.md) (TAR-489) is the
ninth, and the second for an agent — this one for the reader who never opens a settings page
at all. [Set up your workspace](guides/set-up-your-workspace.md) (TAR-414) is the tenth, and the
third for an admin. A guide for a tenant user names its reader in the first line and refers to every
control by its **visible label**, taken from `apps/web/content/en.ts` rather than from a
component name.

**A guide may describe a surface that does not exist yet, if it says so.** TAR-489's last
section told a supervisor that saved replies were managed through the API because no settings
screen had shipped, marked with a `TODO(author)` and the instruction to rewrite it once one
did. That is the honest form: the alternative is a guide that answers half the reader's
question and does not admit which half. TAR-575 shipped the screen and the section became
numbered steps in the same change — which is the other half of the rule: **a `TODO(author)`
naming a missing surface is closed by the story that ships it**, not left to age into a
sentence the product contradicts. What that change could not do in passing was the split the
original `TODO(author)` also asked for, so it left one saying so; TAR-610 carried the section
out to
[Keep the workspace's saved replies up to date](guides/manage-saved-replies.md) and the two
guides now name one reader each. **A `TODO(author)` that outlives the story it was written
for is rewritten to say what is still open**, not deleted because part of it was answered.

**The list stops numbering here.** The ordinals had become the only thing every guide pull
request needed to edit, so each one conflicted with every other on this one sentence — and the
losing branch had to renumber rather than resolve. New guides are named and placed by reader
instead. Two more (TAR-483) cover contacts: [Define the fields your contacts carry](guides/define-custom-contact-fields.md) for
an admin, and [Find a contact and keep their record up to date](guides/find-and-update-contacts.md)
for an agent.
[Automate what happens to a ticket](guides/automate-tickets-with-workflows.md) (TAR-401) is for
a supervisor.
Two more (TAR-415) cover the AI chatbot:
[Set up the chatbot and its knowledge base](guides/set-up-the-chatbot.md) for an admin, and
[Work with the chatbot in the inbox](guides/work-with-the-chatbot-in-the-inbox.md) for an
agent.
[Choose a plan and manage billing](guides/manage-your-plan-and-billing.md) (TAR-622) is for
an admin, and is the first guide whose subject the reader cannot yet do — no environment has
a payment provider connected. It says so in its first paragraph rather than describing a
purchase that cannot happen, which is the same honesty rule the `TODO(author)` above states,
applied to a whole page instead of a section.

One subject splits into two guides when it splits into two permissions. Branding and custom
domains sit on one settings area and read as one topic, but `branding:write` and
`domain:write` are deliberately separate authorities — and the second guide asks its reader
to edit DNS and then wait, which is a different afternoon from picking a colour. One file
would have served neither reader. Custom fields split the same way: `tenant:settings`
defines a field and `contact:write` fills one in, which is two readers on two screens. So
does the chatbot, and it shows the rule is about the reader rather than the screen:
`ai:write` is admin-only and lives on a settings page, while taking a conversation from the
chatbot is `conversation:claim`, which every role holds and every agent meets in the Inbox
without opening a setting at all. Saved replies split on the same seam once TAR-575 gave the
write half a screen: `canned_response:read` is what an agent expands a shortcut with in the
reply box, `canned_response:write` is supervisor-and-above and lives under **Settings**, so
[Answer common questions with saved replies](guides/use-saved-replies.md) and
[Keep the workspace's saved replies up to date](guides/manage-saved-replies.md) are two files
(TAR-610).

**Name what a guide's reader cannot do, under a closing “What this cannot do yet”.** A gap
the reader discovers by hunting for a button is worse than one the page names — and a guide
that implies a guarantee the code does not give is worse than both. TAR-483 shipped that
mistake once: two guides promised concurrent edits were safe while the reference page for
the same surface carried the open bug.

The inverse also holds: one guide covers several subjects when a reader meets them in one
sitting. TAR-414's guide runs the setup checklist, plan limits and suspension together because
that is the arc a new admin actually walks, and three files would have made each of them look
like somebody else's problem.

**A guide that documents a surface should link the reference for the same subject, and the
reference should link back.** The two readers meet at that link and nowhere else: it is what
lets each page refuse the other's material instead of hedging.

## Information architecture

| Path                 | Holds                                                                            | Reader   |
| -------------------- | -------------------------------------------------------------------------------- | -------- |
| `README.md`          | The doorway: what this is, how to run it, where to go next. Short                | Engineer |
| `docs/adr/`          | Architecture decision records. Immutable once accepted; superseded, never edited | Engineer |
| `docs/architecture/` | Cross-cutting design documents and their amendments                              | Engineer |
| `docs/design/`       | The visual design language: what the tokens equal, and the layouts they build    | Engineer |
| `docs/reference/`    | Exhaustive API, schema and contract reference. Complete over readable            | Engineer |
| `docs/guides/`       | Task-oriented how-tos, one goal per file                                         | Either   |
| `docs/concepts/`     | Explanation of the model and the why, where a reader cannot succeed without it   | Engineer |
| `CHANGELOG.md`       | What changed, per release                                                        | Both     |

Do not create a directory you have nothing to put in. `docs/concepts/` does not exist yet,
and should not until something needs it.

**The README is a doorway, not a manual.** Anything longer than a screen belongs in
`docs/` with a link from the README. When you move a section, move it whole and leave a
one-line pointer — a summary that drifts from the reference is worse than a link.

## Voice

- Second person, present tense, active voice. "Run the migration", not "The migration
  should be run".
- Short sentences, one idea each. Cut every word that carries no information.
- British spelling, matching the existing code comments: `behaviour`, `serialisation`,
  `denormalised`, `organisation`.
- No marketing language. No "simply", "just", "easy", "obviously" — they mislead, and
  they condescend to a reader who is stuck.
- Explain _why_ wherever a constraint or trade-off is not self-evident. This codebase
  documents its reasoning in comments; documentation that only restates the _what_ adds
  nothing.

## Terminology

Fixed vocabulary. Use the left column; never rotate synonyms.

| Term                             | Not                                       | Notes                                                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tenant                           | organisation, workspace, account, client  | One customer business on the platform. **Except in `docs/guides/` written for a tenant user**, which says _workspace_ — the word the console itself uses on screen                                                                               |
| handoff                          | transfer, pass on, delegate               | Giving a ticket to somebody else. The console's own word; `ticket:handoff` is the permission                                                                                                                                                     |
| escalate                         | raise, flag, bump, elevate                | Asking a supervisor to look. **Never means the ticket changed hands** — it does not                                                                                                                                                              |
| platform operator                | admin, superadmin, us                     | Operates the platform; not a user inside any tenant                                                                                                                                                                                              |
| agent                            | user, rep, operator                       | A person working inside a tenant. Never means "AI agent"                                                                                                                                                                                         |
| provision                        | create, onboard, sign up                  | `POST /api/v1/admin/tenants`                                                                                                                                                                                                                     |
| deactivate                       | suspend, disable, delete, offboard        | `POST /api/v1/admin/tenants/{slug}/deactivate`                                                                                                                                                                                                   |
| WhatsApp Business Account (WABA) | business account, Meta account            | Spell out at first use per document, then `WABA`                                                                                                                                                                                                 |
| `TenantPrisma` / `SystemPrisma`  | the tenant client / the system client     | Exact casing; they are type and token names                                                                                                                                                                                                      |
| row-level security (RLS)         | row security, database policies           | Spell out at first use per document                                                                                                                                                                                                              |
| tenant-scoped                    | multi-tenant, isolated                    | Carries a non-null `tenant_id` and an RLS policy                                                                                                                                                                                                 |
| ticket                           | case, issue, request                      | One unit of work on a conversation                                                                                                                                                                                                               |
| active queue                     | open queue, active list, the backlog      | `GET /tickets` with no `status`: `open` and `pending`                                                                                                                                                                                            |
| auto-reopen                      | reopen, un-resolve                        | `pending → open` written by the customer's reply                                                                                                                                                                                                 |
| canned response                  | quick reply, snippet, macro, template     | Standing text an agent expands in the composer. **Except in `docs/guides/`**, which says _saved reply_ — the console's own words on screen. Never _template_, which is Meta's approved-message object                                            |
| shortcut                         | trigger, code, slash command              | The `/hours` token. Both readers use this word; only the engineer's pages call `/` the _trigger_                                                                                                                                                 |
| lifecycle state                  | lifecycle status, tenant state            | One of the seven `TENANT_STATUSES`. Spell a value in its schema form — `past_due`, not "past due" — outside `docs/guides/`, which uses the console's badge                                                                                       |
| self-signup                      | sign-up, registration, self-serve signup  | The public path a visitor takes to a tenant. The verb is _sign up_; the noun and the adjective are _self-signup_                                                                                                                                 |
| entitlements                     | plan limits, quotas, caps                 | The whole `{ features, limits }` object on `tenant_entitlements`. An individual ceiling inside `limits` is a **cap**                                                                                                                             |
| seat                             | licence, user slot                        | Held by an `active` or `suspended` member, **and** by every live pending invite                                                                                                                                                                  |
| purge                            | hard delete, erase, wipe                  | The batched deletion that runs at `purge_at`. The lifecycle _state_ it lands in is `deleted`                                                                                                                                                     |
| contact                          | customer record, person, lead             | One customer the tenant has talked to. **The customer** is the human; the contact is the row                                                                                                                                                     |
| custom field                     | custom attribute, extra field, property   | A tenant-defined field on every contact. The **definition** is the schema; the **value** is one contact's                                                                                                                                        |
| tag                              | label, category                           | A shared label on a contact. Never "custom field" — the two are different resources                                                                                                                                                              |
| definition                       | field def, schema row, `custom_field_def` | One row of `custom_field_defs`. The **definition list** is `GET /api/v1/custom-fields`                                                                                                                                                           |
| vocabulary                       | dictionary, lookup set                    | A tenant's complete tag set or definition set, read whole rather than paged. Use it only for that                                                                                                                                                |
| workflow                         | automation rule, recipe, macro            | One trigger, one condition set, one ordered action list (TAR-27). **Never "rule"** — that word is taken by a routing rule, and the two behave differently                                                                                        |
| routing rule                     | assignment rule, rule                     | Where a _new_ ticket goes, first match wins. `assignment_rules` is the table; the prose word is _routing rule_                                                                                                                                   |
| triggering occurrence            | trigger event, firing                     | The one thing a run is claimed against — a ticket event, an SLA timer, or the ticket itself                                                                                                                                                      |
| run                              | execution, invocation                     | One workflow's attempt at one triggering occurrence. "The run history" is the console's own word                                                                                                                                                 |
| dry run                          | simulation, preview                       | `POST /workflows/{id}/test`, which writes nothing. In `docs/guides/` say **Test**, the button's own label                                                                                                                                        |
| chatbot                          | bot, AI, assistant, AI agent              | What answers a customer from the knowledge base. **Never _agent_** — that word is a person. The code says `bot` (`bot_state`, `bot_turns`, `origin: 'bot'`); the prose word is _chatbot_ for both readers                                        |
| knowledge base                   | KB, corpus, index                         | Everything the chatbot may answer from. Spelt out; `KB` never appears in prose                                                                                                                                                                   |
| knowledge document               | article, page, record                     | One row of `knowledge_documents`. **Except in `docs/guides/`**, which says _knowledge base entry_ — the console's own words. A **chunk** is one indexed piece of it; the console calls that a _piece_                                            |
| hand over (chatbot)              | escalate, transfer, pass to a human       | The chatbot giving a conversation to a person. In `docs/reference/` it is a **handoff** — `handoff_events`, `HandoffReason` — and **never** TAR-473's ticket handoff between two agents. `docs/guides/` says _hand over_, the console's own word |
| readiness                        | health, status, bot state                 | The `{ ready, indexedDocumentCount, blockers }` object on `GET /ai/config`. **Never _bot state_**, which is `conversations.bot_state` and describes one conversation                                                                             |

Product entity names take their schema spelling in prose: `conversations`, `tickets`,
`message_templates`. TypeScript identifiers take theirs: `MessageTemplate`,
`ProvisionTenantInputSchema`.

## Formatting

- One `#` per file, matching the filename's subject. Sentence case in every heading.
- Fence every code block with its language: `ts`, `sql`, `bash`, `json`, `text`.
- Tables for parameters, options, columns and error codes. Prose for concepts and
  rationale. A table with one row should have been a sentence.
- Reference code as an inline path, optionally with a line: `apps/api/src/prisma/prisma.tokens.ts`.
  Link only to files a reader will open whole.
- Cross-reference stories as bare identifiers — TAR-52 — not as links. There is no
  public issue tracker URL.

## Code samples and placeholder values

- Every sample must match the real signature, argument order and types. Derive it from
  the source or from a test, never from memory.
- Run the sample where running it is cheap and safe. A sample you did not run is
  labelled as such.
- Realistic placeholders only: `acme`, `Acme Ltd`, `acme.app.example.com`,
  `+966501234567`, `019fed83-ebd1-774d-86e4-46137546a539`. Never `foo`, `bar`, `test123`.
- Never a real secret, token, password, hostname or customer record. Local Docker
  credentials from `.env.example` are not secrets, and may appear where the sample is
  explicitly local.
- Show the response next to the request, including the status code.

## Facts and gaps

Every factual claim traces to source code, a migration, a test, a configuration file or
an explicit decision in `docs/adr` or `docs/architecture`. Two rules follow:

1. **Do not duplicate a machine-readable source by hand.** `apps/api/prisma/schema.prisma`
   and `packages/contracts/src/*.ts` are the source of truth for columns and payload
   shapes. Reference documentation states the things those files cannot show at a glance
   — classification, constraints, relationships, semantics — and points at them for the
   rest. A transcribed column list is a drift surface with no owner.
2. **Mark what you could not verify.** Write it inline as
   `> **TODO(author):** <specific question>` and repeat it in the pull request
   description. Never present an assumption as a documented fact, and never leave a gap
   silently filled.

## File naming

`kebab-case.md`, named for the subject, no dates and no story ids: `admin-api.md`, not
`tar-50-admin-api.md`. ADRs, architecture and design documents keep their numeric prefix
(`0002-architecture-and-api-contract.md`) because their order is part of the record.

**Numbers under `docs/architecture/` are not unique, and are not a citation.** `0009`, `0010`
and `0011` each name two documents, because two designs were numbered in parallel and the
number is the order they were written in rather than an identifier anything resolves. Cite an
architecture document by its **full filename** — `0011-canned-responses-contract.md`, never
"0011" — and take a free number when you add one. A collision is not renamed away once source
comments cite the path: correcting a documentation number by editing application code costs
more than the ambiguity does.

## Templates

### Reference — endpoint

````markdown
### `METHOD /api/v1/path`

One sentence on what it does.

**Authentication.** What the caller presents, and what happens when it is absent.

**Idempotency.** What replaying the call does. Omit the section only if the method is safe.

| Parameter | In   | Type   | Required | Default | Notes |
| --------- | ---- | ------ | -------- | ------- | ----- |
| `field`   | body | string | yes      | —       |       |

```bash
curl -X POST https://api.example.com/api/v1/path \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"field":"value"}'
```

```json
{ "id": "019fed83-ebd1-774d-86e4-46137546a539" }
```

| Status | Code                | Cause |
| ------ | ------------------- | ----- |
| `200`  | —                   |       |
| `400`  | `validation_failed` |       |

Anything the caller must know that the table cannot say: what is written, what is not,
what it deliberately leaves to another story.
````

### Reference — entity

```markdown
### `table_name`

What it represents, in one or two sentences.

- **Tenant-scoped:** yes / no, and why if no.
- **Model:** `ModelName`
- **Unique:** `(tenant_id, field)`
- **Indexes:** `(tenant_id, created_at DESC, id DESC)` — what it serves
- **Relations:** parent → child, and the referential action
- **Owned by:** TAR-nn

Notable columns only — the ones whose semantics are not obvious from the name.
```

### Changelog entry

Group under **Added**, **Changed**, **Fixed**, **Removed**, **Security** — never invent a
sixth group. Story id in parentheses after the lead.

**A small change is one line:**

```markdown
### Added

- Tenant provisioning endpoint `POST /api/v1/admin/tenants`. Idempotent on `slug`;
  authenticated by `PLATFORM_ADMIN_TOKEN`. (TAR-50)
```

**A story-sized change is a bolded lead in the present tense, saying what a reader can now
do, then the reasoning** — what was there before, what was decided, what it cost, and what
was deliberately left out. That is what `CHANGELOG.md` actually contains for every entry
above a line or two, and it is the form to match: this project's changelog is where a
decision's _why_ survives, because the pull request that carried it will not be read again.

```markdown
- **A supervisor can say where new tickets go, and the first matching rule decides**
  (TAR-24) — `assignment_rules` has existed since TAR-47 and nothing read it. …
  ⚠️ Anything stated rather than built goes last, marked, with its follow-up story.
```

Two rules for the long form. **Say the cost, not only the win** — an entry that reads as
unqualified good news is an entry a reader learns to skim. And **⚠️ marks what shipped
knowingly incomplete**, with the story that closes it, so the gap is documented rather than
discovered.
