# Documentation style guide

How documentation in this repository is written, so that a page written by one story reads
like a page written by another. Read this before writing or editing anything under `docs/`
or `README.md`.

It codifies what the repository already does — the voice in `README.md`, ADR 0001 and the
architecture contract — rather than proposing something new. Where you need to deviate,
change this file in the same commit instead of quietly diverging.

## Who reads what

Name the reader before you write, and hold that choice for the whole page. A page written
for everyone serves no one.

| Reader                | Assume                                                      | Where their pages live                   |
| --------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| **Engineer**          | Fluent in TypeScript, SQL and this stack. Wants exact types | `docs/reference/`, `docs/guides/`        |
| **Platform operator** | Runs the product, reads a terminal, does not read the code  | `docs/guides/`, README "Getting started" |
| **Decision reader**   | Wants to know why a choice was made and what it rules out   | `docs/adr/`, `docs/architecture/`        |

There is no end-user documentation in this repository yet. The agent console (`apps/web`)
has no shipped features. When it has, task-oriented user manuals go in `docs/guides/` with
the audience stated in the page's opening line, and they refer to interface elements by
their visible labels and never mention a type, a table or a client.

## Where a page belongs

| Path                 | Holds                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| `README.md`          | The doorway: what this is, how to run it, where to read more. Keep short   |
| `CHANGELOG.md`       | What changed, per release, newest first                                    |
| `docs/adr/`          | Architecture decision records. Numbered, immutable once accepted           |
| `docs/architecture/` | Published contracts other stories build against                            |
| `docs/reference/`    | Exhaustive API, schema and configuration reference. Complete over readable |
| `docs/guides/`       | One task or one contract per file, written to be acted on                  |

Do not create a section you have nothing to put in. `docs/concepts/` does not exist because
nothing yet needs it.

**File names are lowercase kebab-case, with the extension `.md`.** ADRs and architecture
records carry their number first (`0002-architecture-and-api-contract.md`); nothing else
is numbered.

## Voice

- **Second person, present tense, active.** "Run the migration", never "the migration
  should be run".
- **Short sentences, one idea each.** Cut every word that carries no information.
- **Explain why wherever the constraint is not self-evident.** A rule with no reason gets
  removed by the next person who finds it inconvenient. This is the one place length is
  worth spending.
- **State what you verified and what you inferred.** Never present an assumption as a
  documented fact. Where you cannot verify something, write
  `> **TODO(author):** <the specific question>` inline rather than guessing.
- **No marketing language, and none of "simply", "just", "easy" or "obviously".** They
  mislead, and they condescend to a reader who is stuck.

## Terminology

Define a term once, then use it consistently. Never rotate synonyms.

| Use               | Not                                      | Means                                                              |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| tenant            | organisation, workspace, account, client | One client business, the isolation boundary                        |
| platform operator | admin, superadmin, us                    | Whoever holds `PLATFORM_ADMIN_TOKEN`; not a user inside any tenant |
| agent             | user, operator, rep                      | A person working inside a tenant — a `users` row                   |
| tenant-scoped     | multi-tenant, scoped                     | Carries a non-null `tenant_id` and an RLS policy                   |
| provision         | create, onboard, sign up                 | `POST /api/v1/admin/tenants`                                       |
| deactivate        | suspend, disable, delete, offboard       | `POST /api/v1/admin/tenants/{slug}/deactivate`                     |
| WABA              | business account, Meta account           | WhatsApp Business Account. Expand on first use per page            |
| the GUC           | the setting, the session variable        | `app.tenant_id`, set per transaction                               |
| `TenantPrisma`    | the scoped client, the tenant client     | The client injected as `TENANT_PRISMA`                             |
| `SystemPrisma`    | the admin client, the unscoped client    | The client injected as `SYSTEM_PRISMA`                             |

Write story identifiers as `TAR-49`, in prose, and only where the reader gains something —
who owns a decision, or where the reasoning is recorded. A reference table does not need a
story column on every row.

## Structure

- One `#` H1 per page, matching the file's subject. Sentence case, not Title Case.
- `##` for the sections a reader scans for. `###` for the pieces inside one. Do not go
  deeper — a fourth level means the page is two pages.
- Lead with what the page is and who it is for, in two or three sentences, before the first
  `##`.
- Put the shortest working path first and the edge cases after it.

## Tables and prose

**Use a table for parameters, options, fields, error codes and configuration keys** — a
reader scans those, and prose hides one row among ten. Every parameter table carries the
same columns in the same order:

| Field | Type | Required | Default | Description |

**Use prose for concepts, rationale and trade-offs.** A table cannot hold "why", and
squeezing a reason into a cell makes it unreadable.

## Code samples

- **Fence every block with its language** — `ts`, `sql`, `bash`, `json`, `prisma`.
- **Use realistic placeholder values.** `acme`, `Acme Ltd`, `+966501234567`,
  `https://api.example.com`, `019f8c…`. Never `foo`, `bar` or `test123`.
- **Match the real signature.** Argument order, types and field names must be copied from
  the source, not remembered. A sample that does not compile is worse than no sample.
- **Show the response next to the request**, as a comment, with the status code:

  ```bash
  curl -X POST http://localhost:3001/api/v1/admin/tenants \
    -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"slug":"acme","name":"Acme Ltd"}'

  # 201 Created
  # {"id":"019f8c…","slug":"acme","name":"Acme Ltd","status":"active", …}
  ```

- **Never include a real secret, token, password, hostname or customer record.** The local
  Docker password in `.env.example` is a throwaway for a container bound to localhost and
  is the only credential that may appear anywhere. If you encounter anything else, redact
  it and say in your summary that you did.
- **Label an untested sample.** If you could not run it, say so on the line above it.

## Linking

- Link to a file with a path relative to the page, and check that it resolves. From
  `docs/reference/`, that is `[`app-roles.sql`](../../apps/api/prisma/sql/app-roles.sql)`;
  from `README.md`, `[`app-roles.sql`](apps/api/prisma/sql/app-roles.sql)`.
- Reference a code location as inline code with a line number — `` `apps/api/src/prisma/tenant-scope.extension.ts:122` `` — not as a link.
- Link a term to the page that defines it the first time it appears on a page, then stop.

## The changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Newest
release first, `## [Unreleased]` at the top, and the standard groups in this order:
`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

Write each entry for someone deciding whether this release affects them: what changed and
what they now have to do, not which files moved. One line each; put the detail in the doc
the line links to. A change that needs an operator step — a new migration, a re-run of
`pnpm db:roles`, a new required environment variable — says so in the entry itself.

## Templates

### An API endpoint

````markdown
### `POST /api/v1/resource/{id}/verb`

One sentence on what it does and when to call it.

**Authentication:** how, and what happens without it.

**Path parameters**

| Field | Type | Required | Default | Description |
| ----- | ---- | -------- | ------- | ----------- |

**Request body**

| Field | Type | Required | Default | Description |
| ----- | ---- | -------- | ------- | ----------- |

**Request**

```bash
curl …
```

**Response — 200 OK**

```json
{}
```

| Field | Type | Description |
| ----- | ---- | ----------- |

**Errors**

| Status | `code` | Cause |
| ------ | ------ | ----- |

**Semantics** — idempotency, rate limits, pagination, side effects, and anything a caller
would otherwise learn the hard way.
````

### A guide

```markdown
# Doing the thing

Who this is for, and what they will have at the end. Two sentences.

## Before you start

Prerequisites, as a list.

## Steps

1. Imperative step. What you should see afterwards.
2. …

## Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
```
