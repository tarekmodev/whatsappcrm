# Tenant-scoped data access

The contract every story built on TAR-19 writes against — TAR-20, TAR-21, TAR-22, TAR-35 and
everything after them. Read this before your first query.

It covers what `TenantPrisma` and `SystemPrisma` guarantee, what they refuse, and the four
places the guarantee has an edge. For the tables themselves, see the
[data model reference](../reference/data-model.md).

## The short version

- **Inject `TENANT_PRISMA`.** It is scoped to the tenant in the ambient request context, and
  it refuses to run at all when there is no tenant in scope.
- **`SYSTEM_PRISMA` reads and writes every tenant.** Five call sites are permitted. A sixth
  needs a justification in review.
- **You do not write `where: { tenantId }`.** Row-level security filters every scoped table
  in the database. Add the predicate only where a query plan needs it — see
  [When to pass `tenantId` anyway](#when-to-pass-tenantid-anyway).
- **A scoped query costs about 2 ms more than an unscoped one.** Use
  `$tenantTransaction` for anything issuing several statements.

## How isolation is enforced

Three mechanisms, each covering what the one above it cannot.

**1. The database filters rows.** All 34 tenant-scoped tables carry `FORCE ROW LEVEL
SECURITY` and one policy:

```sql
CREATE POLICY tenant_isolation ON conversations
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

`current_setting(…, true)` returns NULL rather than raising when the GUC was never set.
`NULLIF(…, '')` covers the second, less obvious case: a GUC that _was_ set and has since been
reset — which is what a transaction-local `set_config` leaves behind at commit — reads back
as the empty string, not NULL, and would reach the `::uuid` cast and fail the query instead of
returning nothing. Either way the comparison yields NULL, which is not `true`, so **no GUC
means zero rows, never unscoped access**. The dangerous inverse is impossible by
construction: there is no value of the setting that matches more than one tenant.

`WITH CHECK` covers writes, so a handler that took a `tenant_id` from a request body cannot
insert into another tenant. `FORCE` extends the policy to the table owner, which matters
because migrations run as the owner.

**2. The role cannot bypass it.** `whatsappcrm_app` — what `TenantPrisma` connects as — holds
neither `SUPERUSER` nor `BYPASSRLS`. Both skip policy evaluation entirely, and neither is a
table property RLS can close.

**3. The client sets the GUC, and fails closed before it.** `TenantPrisma` wraps every
statement:

```sql
BEGIN;
SELECT set_config('app.tenant_id', public.assert_tenant_active($1), true);  -- true = transaction-local
<the query>;
COMMIT;
```

Transaction-local, so a pooled connection cannot carry one request's tenant into the next.
With no tenant in scope the client throws `MissingTenantContextError` **before anything is
sent** — the query never happens, rather than happening and returning nothing. That
distinction is the point: zero rows is indistinguishable from an empty table, so a code path
that forgot to resolve its tenant would look like a working one.

`assert_tenant_active` is the deactivation gate. It returns the tenant id when that tenant is
`active` and raises `TN001` otherwise. Postgres evaluates it before `set_config`, so a
deactivated tenant never sets the GUC the policies read, and the statement batched behind it
never runs.

## Getting a tenant into scope

The tenant travels in `TenantContextService`, an `AsyncLocalStorage` scope shared by HTTP
requests, queue workers and WebSocket handlers. `TenantPrisma` reads from there and nowhere
else.

```ts
// HTTP: TAR-35's AuthGuard calls this once the session is verified.
tenantContext.setTenant(tenantId, userId);

// A worker or a WebSocket handler opens its own scope.
await tenantContext.run({ requestId, tenantId, userId: null }, () => processJob(job));
```

Use `requireTenantId()` wherever a missing tenant is a bug — it throws rather than letting an
unscoped path continue. Do not build a second mechanism for carrying the tenant.

## Choosing a client

| Token           | Connects as          | Sees                                           |
| --------------- | -------------------- | ---------------------------------------------- |
| `TENANT_PRISMA` | `whatsappcrm_app`    | Only the tenant in the ambient request context |
| `SYSTEM_PRISMA` | `whatsappcrm_system` | Every tenant                                   |

```ts
constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}
```

`SystemPrisma` is a **separate client, not a flag** on the tenant one. A flag is one typo
away from being set, invisible at the injection site, and impossible to review by search; a
token appears in the constructor of every class allowed to use it, and nowhere else.

It is the widest hole in the isolation model — it carries a `system_unrestricted` policy on
every protected table — so TAR-39 confines it to five call sites:

1. Tenant provisioning and lifecycle
2. Login, before a tenant is known
3. Webhook ingest
4. The sweeper
5. Platform reporting

A sixth needs a justification in review. If you are reaching for it because `TenantPrisma`
refused something, the refusal is usually correct — read the error, it names the reason.

## Writing a query

**Reads take no `tenantId` filter.** RLS applies it:

```ts
const conversations = await this.prisma.conversation.findMany({
  where: { status: 'open' },
  orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
  take: 50,
});
```

**Writes still name the tenant**, because `tenant_id` is `NOT NULL` on every scoped table and
the client does not fill it in. Take it from the context, never from a request body:

```ts
const note = await this.prisma.internalNote.create({
  data: {
    tenantId: this.tenantContext.requireTenantId(),
    conversationId,
    authorUserId,
    body,
    mentionedUserIds: [],
  },
});
```

Passing it is safe rather than a hole: `WITH CHECK` rejects the insert if the value is not
the tenant in scope, so the database verifies the claim rather than trusting it. The
alternative Prisma accepts — `tenant: { connect: { id } }` alongside the other relations —
is equivalent and more verbose; either is fine, and consistency inside a module matters more
than the choice.

### Multi-statement work

Use `$tenantTransaction`. It opens one transaction, sets the GUC once, and pays the round-trip
cost a single time instead of per statement:

```ts
await this.prisma.$tenantTransaction(async (tx) => {
  const conversation = await tx.conversation.update({ where: { id }, data: { unreadCount: 0 } });
  await tx.message.updateMany({
    where: { conversationId: id, readAt: null },
    data: { readAt: new Date() },
  });
  return conversation;
});
```

**Batch `$transaction([…])` does not work on `TenantPrisma`.** The extension hook is `async`,
so the client returns ordinary promises rather than the `PrismaPromise`s a batch needs.

## The three tables RLS does not cover

`tenants`, `plans` and `webhook_events` carry no policy — see
[the data model reference](../reference/data-model.md#counts-and-the-three-exceptions) for
why. `TenantPrisma` applies its own rule to each, so the gap is closed in the client rather
than left open:

| Model          | Rule             | Behaviour                                                         |
| -------------- | ---------------- | ----------------------------------------------------------------- |
| `Tenant`       | own-row          | Reads are narrowed to the tenant in scope; every write is refused |
| `Plan`         | shared read-only | Reads pass through; every write is refused                        |
| `WebhookEvent` | system-only      | Every operation is refused — reach it through `SystemPrisma`      |

The narrowing on `Tenant` appends `AND: [{ id: tenantId }]` to your `where` rather than
setting `id` directly, so a caller's own `id` filter is intersected with it and cannot
override it: asking for another tenant returns nothing.

**Inside `$tenantTransaction` these three rules do not apply.** The client handed to your
callback is the un-extended transaction client — the GUC is already set for the whole
transaction, and re-applying it per statement would nest a transaction inside itself. RLS
still covers every other model. Read `Tenant` outside the transaction, or filter it by hand.

## What `TenantPrisma` throws

| Error                       | Means                                                            | Whose bug                                      |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `MissingTenantContextError` | A query reached the client with no tenant in scope               | Yours — resolve the tenant first               |
| `UnscopedModelAccessError`  | One of the three models above, reached a way it cannot be scoped | Yours — use `SystemPrisma`, or do not write it |
| `TenantNotActiveError`      | The tenant in scope is not `active`                              | Nobody's — an operator deactivated it          |

The first two are `TenantPrismaError`s and are coding mistakes: anything that could
legitimately reach an end user should have been caught by a guard long before the query.

`TenantNotActiveError` is deliberately **not** in that family. A deactivated tenant still
holding a session is a state an operator created on purpose, and reporting it as a fault
would page somebody every time. It belongs in front of the caller as a `403`.

> **TODO(author):** nothing maps `TenantNotActiveError` to a response yet.
> `ApiExceptionFilter` catches only `ApiException`, so today the error reaches Nest's default
> handler and the caller sees a bare `500`. TAR-41 owns the global filter that maps it to
> `forbidden`. Confirm with TAR-41 whether that mapping lands there or in a TAR-36 guard, and
> update this table when it does.

## Four things to know before you rely on this

**1. A scoped query costs three extra round trips.** Measured against the local Compose
stack: 0.7 ms for a plain query, 2.3–3.4 ms for a scoped one. Prisma 7's driver-adapter
client sends `BEGIN`, `set_config`, the query and `COMMIT` as four separate messages, not one
batched round trip. The deactivation check adds nothing on top — it is a primary-key lookup
inside the `set_config` statement that was already being sent. `$tenantTransaction` is the
fix for any path issuing several statements.

**2. RLS carries the guarantee; it does not always carry the plan.** Measured by TAR-48 on
50k conversations across 20 tenants, the inbox query drops from an index-only scan reading 50
rows to a bitmap scan of the whole tenant plus a top-N sort. The cause is that `enum_eq` is
not leakproof, so under RLS a `status = 'open'` qual cannot be pushed into the index
condition. It does not matter at this size and it will at a large tenant's.

**3. The client does not inject `tenantId` for you, and that is deliberate.** A generic
injection has to get nested writes, `connect`, `upsert` and relation filters right or it
silently drops rows — worse than not having it. RLS already filters correctly and uses the
same `(tenant_id, …)` index a hand-written filter would.

**4. Never call `set_config('app.tenant_id', …, false)`.** The session-level form survives
the transaction, and on a pooled connection that is a cross-tenant leak. There is none in
this codebase; the integration test asserts a connection reused across two tenants stays
honest.

### When to pass `tenantId` anyway

Only to restore a query plan, per point 2 above. Add it to the query's own `where`; the
policy still applies, and the two predicates agree:

```ts
await this.prisma.conversation.findMany({
  where: { tenantId: this.tenantContext.requireTenantId(), status: 'open' },
  orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
  take: 50,
});
```

Do not do this by default. An explicit filter that drifts from the GUC is a bug the policy
will hide by returning nothing.

## Proving it still works

Two checks, and CI runs both on every pull request:

```bash
pnpm db:verify:rls   # in SQL, as each role, against a two-tenant fixture
pnpm test:db         # the same guarantee through TenantPrisma, plus provisioning
```

`db:verify:rls` creates two tenants, reconnects so the connection has genuinely never set the
GUC, and asserts that all 34 tables return zero rows; that each tenant then sees its own rows
and none of the other's; and that a cross-tenant insert is rejected while a cross-tenant
update or delete matches nothing. It fails if either role ever acquires `BYPASSRLS`, and it
reads the catalog rather than a list, so a table added without a policy is caught by name. It
writes to the database it is pointed at — point it at a local or disposable one.

**Isolation is a property of the database, not of any one function.** A unit test cannot
assert it, which is why both checks need a running Postgres.
