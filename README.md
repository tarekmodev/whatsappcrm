# WhatsApp CRM

Multi-tenant, white-label WhatsApp CRM and helpdesk platform, built on the official
WhatsApp Business Cloud API.

> **Status: scaffold.** This repository currently contains the project skeleton and the
> stack decision only — no product features. Feature work is tracked as the TAR-18 epic.
> The full local-development guide, including a seeded database, is owned by TAR-42; the
> steps below are what works today.

## Stack

TypeScript on Node 22 · NestJS 11 API · Next.js 16 frontend · PostgreSQL · Prisma ·
Socket.IO · BullMQ on Redis · deployed to Render.

Every one of those choices, the alternatives weighed against it, and the failure modes
they imply are recorded in **[`docs/adr/0001-stack-decision.md`](docs/adr/0001-stack-decision.md)**.
Read that before proposing a change to any of them.

Prisma, Socket.IO and BullMQ are decided but not yet installed — each arrives with the
story that first needs it.

## Layout

| Path                 | What it is                                                   |
| -------------------- | ------------------------------------------------------------ |
| `apps/api`           | NestJS HTTP API                                              |
| `apps/web`           | Next.js agent console                                        |
| `packages/contracts` | Zod schemas and types shared by both apps — the API contract |
| `packages/tsconfig`  | Shared TypeScript configuration                              |
| `docs/adr`           | Architecture decision records                                |

## Getting started

Requires **Node 22** (`.nvmrc`) and **pnpm 9**.

```bash
pnpm install
cp .env.example .env     # defaults are enough to boot the scaffold
pnpm dev
```

`pnpm dev` runs both apps: the API on <http://localhost:3001/api> and the frontend on
<http://localhost:3000>.

Check the API is up:

```bash
curl http://localhost:3001/api/health
# {"status":"ok","version":"0.0.0","uptimeSeconds":3,"checks":{}}
```

No database or Redis is needed yet — `DATABASE_URL` and `REDIS_URL` are optional until
TAR-41 provisions them.

## Commands

Run from the repository root; Turborepo fans each one out across the workspaces.

| Command          | What it does                                        |
| ---------------- | --------------------------------------------------- |
| `pnpm dev`       | Runs the API and the frontend in watch mode         |
| `pnpm build`     | Builds every package                                |
| `pnpm typecheck` | Type-checks every package                           |
| `pnpm test`      | Runs all tests — Jest for the API, Vitest elsewhere |
| `pnpm lint`      | ESLint across the whole repository                  |
| `pnpm format`    | Applies Prettier                                    |

## Configuration

`.env.example` is the documented contract for every environment variable and is the file
to update when a key is added. It holds **no values** — deployed environments read their
secrets from the platform's secret store, never from a committed file.

For the API, `.env.example` must stay in sync with
`apps/api/src/config/env.schema.ts`, which validates the environment at boot and refuses
to start if a required key is missing or malformed.

## Conventions worth knowing before you write code

- **Tenant scoping goes through `TenantContextService`**
  (`apps/api/src/common/tenant-context/`). It is an `AsyncLocalStorage` scope that works
  in HTTP requests, queue workers and WebSocket handlers alike. Do not build a second
  mechanism. Use `requireTenantId()` wherever a missing tenant is a bug — it throws
  rather than letting an unscoped query run.
- **Shared types live in `packages/contracts`.** If the API and the frontend both need to
  know a shape, it is a Zod schema there, not a duplicated interface.
- **Errors have one envelope** (`ApiErrorSchema`), and the frontend has one error type
  (`ApiRequestError` in `apps/web/lib/api.ts`). Every response carries `x-request-id`,
  which ties a user-reported error to a log line.

## License

MIT — see [LICENSE](LICENSE).
