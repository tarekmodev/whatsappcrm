# Tenant isolation contract

What every module built on TAR-19 has to know: how a query acquires its tenant, which
client to inject, and what the database refuses. Written for engineers. This is the
contract TAR-20, TAR-21, TAR-22 and TAR-35 import.

The short version: **isolation is enforced by the database, not by application code
remembering a `where` clause.** You do not filter by `tenant_id`. You resolve a tenant into
the ambient context and use the right client, and the rest is a row-level security policy.

## The mechanism

Three pieces, each of which fails closed on its own.

### 1. Row-level security on every tenant-scoped table

All 34 tenant-scoped tables have `ENABLE`/`FORCE ROW LEVEL SECURITY` and one policy:

```sql
CREATE POLICY tenant_isolation ON conversations
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

Three properties fall out, and all three are what make this worth having:

- **A connection that has not set the GUC sees nothing.** Not everything — nothing. The
  never-set case (`current_setting` returns NULL) and the cleared case (it returns the empty
  string, which is what the `NULLIF` is for) both fail closed.
- **`FORCE` includes the table owner.** Without it, migrations — and anything else connecting
  as the owner — would be exempt, which is the opposite of what you want.
- **Writes are checked too.** `WITH CHECK` means a handler that takes a `tenant_id` from a
  request body cannot write into another tenant; the insert is rejected outright.

### 2. Two database roles

Which role a client connects as _is_ the guarantee. Created by
`apps/api/prisma/sql/app-roles.sql`, not by a migration — roles are cluster-scoped, a login
role needs a password that belongs in a secret store, and `CREATE ROLE` needs a privilege the
deploy user on a managed PostgreSQL may not have.

| Role                 | Holds                                                       | Sees                               |
| -------------------- | ----------------------------------------------------------- | ---------------------------------- |
| `whatsappcrm_app`    | No `SUPERUSER`, no `BYPASSRLS`. DML on tenant-scoped tables | Only the tenant in `app.tenant_id` |
| `whatsappcrm_system` | The same, plus a `system_unrestricted` policy per table     | Every tenant                       |

`SUPERUSER` and `BYPASSRLS` skip policy evaluation entirely, so the app role must hold
neither — `pnpm db:verify:rls` fails if it ever does, and `app-roles.sql` re-asserts
`NOSUPERUSER NOBYPASSRLS` on every run rather than assuming it.

`system_unrestricted` is deliberately a _policy_ rather than the `BYPASSRLS` role attribute.
`BYPASSRLS` is cluster-wide, applies to every table in every database, cannot be narrowed and
leaves no trace in a table's definition. A policy is per-table, shows up in `pg_policies` next
to the one it overrides, and can be revoked one table at a time.

### 3. The GUC, set per transaction by `TenantPrisma`

```sql
BEGIN;
SELECT set_config('app.tenant_id', public.assert_tenant_active($1), true);  -- true = transaction-local
<the query>;
COMMIT;
```

`set_config(..., true)` is transaction-local, so a pooled connection cannot carry one
request's tenant into the next one. A session-level `set_config(..., false)` anywhere in this
codebase would be a cross-tenant leak; there is none, and the integration suite asserts that a
connection reused across two tenants stays honest.

The tenant comes from `TenantContextService`'s `AsyncLocalStorage`, which HTTP requests, queue
jobs and WebSocket handlers all share.

## Choosing a client

`apps/api/src/prisma` exports two. Which one a class injects is a design decision, not a
convenience.

| Token           | Type           | Connects as          | Sees                                           |
| --------------- | -------------- | -------------------- | ---------------------------------------------- |
| `TENANT_PRISMA` | `TenantPrisma` | `whatsappcrm_app`    | Only the tenant in the ambient request context |
| `SYSTEM_PRISMA` | `SystemPrisma` | `whatsappcrm_system` | Every tenant                                   |

```ts
import { Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

@Injectable()
export class ConversationsService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  // No tenantId filter. RLS applies it.
  findOpen() {
    return this.prisma.conversation.findMany({
      where: { status: 'open' },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
  }
}
```

`PrismaModule` is `@Global()`, so there is nothing to import: a feature module that had to
remember to import it is one that will eventually construct its own client with the wrong
connection string. Both clients are process singletons rather than request-scoped — request
scope would rebuild the provider subtree per request and still would not exist for queue
workers or WebSocket handlers.

### `SystemPrisma` is confined to five call sites

`SystemPrisma` reads and writes across tenants, which makes it the widest hole in the
isolation model and the first place a review should look. The architecture document permits
exactly five uses:

1. Tenant provisioning
2. Login, before a tenant is known
3. Webhook ingest
4. The sweeper
5. Platform reporting

A sixth needs a justification in review. It is a **separate client, not a flag** on the tenant
one, precisely so that this is reviewable: a flag is one typo away from being set, invisible
at the injection site, and impossible to find by search. `SYSTEM_PRISMA` appears in the
constructor of every class allowed to use it, and nowhere else.

## Using `TenantPrisma`

### Multi-statement work goes through `$tenantTransaction`

The per-statement path pays for its own transaction every time. Prisma 7's driver-adapter
client sends `BEGIN`, `set_config`, the query and `COMMIT` as four separate messages rather
than one batched round trip — measured by TAR-49 against the local Compose stack at 0.7 ms for
a plain query and 2.3–3.4 ms for a scoped one. For anything issuing several statements, open
the transaction once:

```ts
await this.prisma.$tenantTransaction(async (tx) => {
  const conversation = await tx.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: sentAt, unreadCount: { increment: 1 } },
  });

  await tx.message.create({ data: { conversationId: conversation.id /* ... */ } });
});
```

It accepts `{ maxWait, timeout, isolationLevel }`.

Two things to know about the client handed to your callback:

- **It is the un-extended transaction client.** The GUC is already set for the whole
  transaction, so re-applying it per statement would nest a transaction inside itself.
- **The special-model rules below do not apply inside it.** `tx.tenant.findMany()` is _not_
  narrowed to the tenant in scope the way `tenantPrisma.tenant.findMany()` is. Row-level
  security still covers every other model. Read `Tenant` outside the transaction, or filter it
  by hand.

### Batch `$transaction([...])` does not work

The extension's hook is `async`, so the extended client returns ordinary promises rather than
the `PrismaPromise`s an array batch needs. Use `$tenantTransaction`.

### The three tables with no RLS policy

`tenants`, `plans` and `webhook_events` carry no `tenant_isolation` policy, so `TenantPrisma`
applies its own rule instead. Anything not listed here is tenant-scoped and needs nothing from
the client beyond the GUC.

| Model          | Rule               | Reads                            | Writes                                          |
| -------------- | ------------------ | -------------------------------- | ----------------------------------------------- |
| `Tenant`       | `own-row`          | Narrowed to the tenant in scope  | Refused — `UnscopedModelAccessError`            |
| `Plan`         | `shared-read-only` | Allowed; platform-wide catalogue | Refused — `UnscopedModelAccessError`            |
| `WebhookEvent` | `system-only`      | Refused                          | Refused — the app role is granted nothing on it |

The narrowing on `Tenant` appends `AND: [{ id: tenantId }]` rather than setting `id`, so a
caller's own `id` filter is intersected with it and cannot overwrite it: asking for another
tenant returns nothing.

This exists because the app role holds an unfiltered `SELECT` on `tenants`, which
`app-roles.sql` records as known residual exposure. It is load-bearing in one direction:
`assert_tenant_active` reads `tenants` as the **calling** role, so narrowing that grant would
require making the function `SECURITY DEFINER` in the same change.

### The extension does not inject `tenantId`

Deliberately. RLS already filters the 34 scoped models, and a generic injection has to get
nested writes, `connect`, `upsert` and relation filters right or it silently drops rows —
worse than not having it.

The one case where you should pass `tenantId` in the query's own `where` is a plan problem, not
a correctness one. Measured by TAR-48 on 50k conversations across 20 tenants, the inbox query
drops from an index-only scan reading 50 rows to a bitmap scan of the whole tenant plus a top-N
sort. The cause is that `enum_eq` is not leakproof, so under RLS a `status = 'open'` qual cannot
be pushed into the index condition. Two things restore the plan: a partial index, or an explicit
`tenantId` in the `where`. It does not matter at current volume and it will at a large tenant's.

### Raw SQL is covered

`$queryRaw` and `$executeRaw` go through the same hook and get the same GUC. That is the half
an argument-rewriting extension cannot reach, and the reason row-level security — rather than
the client — is the layer that carries the guarantee.

## The deactivation gate

`public.assert_tenant_active(text)` returns the tenant id when that tenant is `active` and
raises `TN001` otherwise. PostgreSQL evaluates it before `set_config`, so a deactivated tenant
never sets the GUC and the statement batched behind it never runs.

```sql
SELECT set_config('app.tenant_id', public.assert_tenant_active($1), true)
```

It refuses on all of: no tenant id, an id that is not a UUID, an id no tenant carries, and any
status other than `active`. The caller learns nothing about which — a hard-deleted tenant and a
suspended one answer identically.

Observed on a local stack, as the app role:

```text
SET ROLE whatsappcrm_app;
SELECT set_config('app.tenant_id', public.assert_tenant_active('019fed83-…-46137546a539'), true);
ERROR:  TENANT_NOT_ACTIVE: tenant 019fed83-…-46137546a539 is suspended

SELECT count(*) FROM conversations;   -- no GUC set at all
 count
-------
     0
```

Properties that make this the mechanism rather than a convenience:

- **It takes effect on the next statement.** The status is read inside the transaction that is
  about to run, not from a cache with a TTL. Access control with an eventual-consistency window
  is not access control.
- **It covers every path.** Model queries, raw SQL, queue workers, WebSocket handlers. There is
  no `TenantPrisma` path that reaches a row without passing through it.
- **It costs no extra round trip.** A primary-key lookup on `tenants` inside the `set_config`
  statement that was already being sent.
- **It does not touch `SystemPrisma`**, which never sets the GUC. Support tooling, billing,
  export and the platform-admin surface must keep working on a deactivated tenant — that is the
  difference between revoking access and losing the data.

The call site is schema-qualified (`public.assert_tenant_active`) and the function pins its own
`SET search_path = pg_catalog, public`. Unqualified, it resolves through the connection's
`search_path`, and a connection without `public` on its path fails with "function does not
exist" on every tenant statement — fail-closed, but a full outage rather than a refusal.

## Errors

`apps/api/src/prisma/prisma.errors.ts`. All are plain `Error`s, not `HttpException`s — the data
layer has no business choosing a status code — but they fall into two families, and the
difference decides how a filter should report them.

| Error                       | Thrown when                                                        | Family                           | Report as        |
| --------------------------- | ------------------------------------------------------------------ | -------------------------------- | ---------------- |
| `MissingTenantContextError` | A query reached `TenantPrisma` with no tenant in the ambient scope | `TenantPrismaError` — a bug      | `internal_error` |
| `UnscopedModelAccessError`  | `Tenant`, `Plan` or `WebhookEvent` reached in a disallowed way     | `TenantPrismaError` — a bug      | `internal_error` |
| `TenantNotActiveError`      | The tenant in scope is not `active`                                | Not a bug — an operator did this | `forbidden`      |

**No tenant in scope throws before anything is sent.** The query never happens, rather than
happening and returning nothing. That distinction is the whole point: zero rows is
indistinguishable from an empty table, so a code path that forgot to resolve its tenant would
look like a working one. The database is the second line and would return zero rows anyway.

`TenantNotActiveError` is deliberately outside the `TenantPrismaError` family. A filter that
reported it as `internal_error` would page somebody every time an operator deactivated a tenant
with a session still open.

Match the families with the `kind` discriminator (`TENANT_PRISMA_ERROR`,
`TENANT_NOT_ACTIVE_ERROR`) rather than an `instanceof` chain.

## Rules for a new module

1. **Inject `TENANT_PRISMA`.** If you think you need `SYSTEM_PRISMA`, check the five call
   sites first and be ready to justify a sixth in review.
2. **Do not filter by `tenant_id`.** RLS does it. Add an explicit `tenantId` to a `where` only
   to fix a measured query plan, and say so in a comment.
3. **Resolve the tenant through `TenantContextService`.** It is an `AsyncLocalStorage` scope
   that works in HTTP requests, queue workers and WebSocket handlers alike. Do not build a
   second mechanism. Use `requireTenantId()` wherever a missing tenant is a bug.
4. **Put a `tenantId` on every queue job payload**, set at enqueue time. A worker has no
   request to resolve a tenant from.
5. **Every new tenant-scoped table gets its policy in the same migration**, plus a
   `pnpm db:roles` re-run. See
   [`data-model.md`](data-model.md#adding-a-table).
6. **Do not return a Prisma model directly from a handler.** Map it explicitly, so adding a
   column cannot quietly add a field to the API. That mapping is where a `password_hash` or an
   `access_token_encrypted` would otherwise escape.

## Verifying it

Two checks, and they prove different things. CI runs both on every pull request.

```bash
pnpm db:verify:rls   # SQL, against the catalog
pnpm test:db         # the same guarantee through TenantPrisma
```

`pnpm db:verify:rls` creates two tenants, reconnects so the connection has genuinely never set
the GUC, and asserts that all 34 tables return zero rows; that each tenant then sees its own
rows and none of the other's; that a cross-tenant insert is rejected and a cross-tenant update
or delete matches nothing. It reads the catalog rather than a list, so a new table with no
policy is caught by name rather than assumed to be fine. It exits non-zero on the first failure
and cleans up after itself — and it writes to the database it is pointed at, so point it at a
local or disposable one.

`pnpm test:db` covers the same guarantee through the client, plus provisioning and
deactivation. Isolation is a property of the database rather than of any one function, so a
unit test cannot assert it.

Both passed with `main` at `6b900e2`: `PASS — tenant isolation is enforced at the data
layer`, and 70 integration tests across 5 suites.
