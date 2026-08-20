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
fourth and [Hand a ticket on, or ask a supervisor](guides/hand-over-or-escalate-a-ticket.md)
(TAR-473) the fifth. A guide for a tenant user names its reader in the first line and refers to
every control by its **visible label**, taken from `apps/web/content/en.ts` rather than from a
component name.

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

| Term                             | Not                                      | Notes                                                                                                                                                              |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tenant                           | organisation, workspace, account, client | One customer business on the platform. **Except in `docs/guides/` written for a tenant user**, which says _workspace_ — the word the console itself uses on screen |
| handoff                          | transfer, pass on, delegate              | Giving a ticket to somebody else. The console's own word; `ticket:handoff` is the permission                                                                       |
| escalate                         | raise, flag, bump, elevate               | Asking a supervisor to look. **Never means the ticket changed hands** — it does not                                                                                |
| platform operator                | admin, superadmin, us                    | Operates the platform; not a user inside any tenant                                                                                                                |
| agent                            | user, rep, operator                      | A person working inside a tenant. Never means "AI agent"                                                                                                           |
| provision                        | create, onboard, sign up                 | `POST /api/v1/admin/tenants`                                                                                                                                       |
| deactivate                       | suspend, disable, delete, offboard       | `POST /api/v1/admin/tenants/{slug}/deactivate`                                                                                                                     |
| WhatsApp Business Account (WABA) | business account, Meta account           | Spell out at first use per document, then `WABA`                                                                                                                   |
| `TenantPrisma` / `SystemPrisma`  | the tenant client / the system client    | Exact casing; they are type and token names                                                                                                                        |
| row-level security (RLS)         | row security, database policies          | Spell out at first use per document                                                                                                                                |
| tenant-scoped                    | multi-tenant, isolated                   | Carries a non-null `tenant_id` and an RLS policy                                                                                                                   |
| ticket                           | case, issue, request                     | One unit of work on a conversation                                                                                                                                 |
| active queue                     | open queue, active list, the backlog     | `GET /tickets` with no `status`: `open` and `pending`                                                                                                              |
| auto-reopen                      | reopen, un-resolve                       | `pending → open` written by the customer's reply                                                                                                                   |

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
