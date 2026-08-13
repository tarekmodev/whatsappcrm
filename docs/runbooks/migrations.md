# Migrations in a deployed environment

Authoring a migration, the local Docker stack, and the `down.sql` convention are in
the **Working with the database** section of [`README.md`](../../README.md). This
page is only about what happens to a migration once it leaves a laptop.

## How one reaches an environment

Nobody applies a migration by hand.

Every API service in `render.yaml` carries a pre-deploy hook:

```
preDeployCommand: pnpm db:migrate:deploy   # prisma migrate deploy
```

Render runs it after the build and **before** the new instance starts serving, so:

1. The migration and the application code come from the same build — schema version
   and code version cannot drift apart.
2. A failing migration aborts the deploy. The previous instance keeps serving.
3. Development deploys on every commit, staging when CI is green, production only
   when promoted — so a migration is exercised twice before it reaches real tenant
   data.

`prisma migrate deploy` is idempotent: it applies only what is missing and exits `0`
when there is nothing to do.

`DATABASE_URL` comes from the Render environment, wired from that environment's own
database. There is no way to point the hook at a different one by hand.

## Reversibility

CI enforces it. `pnpm --filter @whatsappcrm/api db:check-migrations` fails when a
migration directory has no `down.sql`, or when that file manages its transaction in a
way `db:rollback` cannot apply atomically (see below), and it runs on every pull
request — a migration that cannot be undone cannot be merged.

To undo the most recently applied migration against any target:

```bash
export DATABASE_URL=...                               # read it back before continuing
pnpm --filter @whatsappcrm/api db:rollback            # prints the plan, changes nothing
pnpm --filter @whatsappcrm/api db:rollback --confirm  # runs it
```

It takes a Postgres advisory lock, then sends the `_prisma_migrations` delete and that
migration's `down.sql` to the server as **one statement batch**, so both land in a
single transaction and a half-applied rollback is not a state you can end up in.
Removing that row is what lets `db:migrate:deploy` apply the migration again; applying
a `down.sql` by hand and forgetting it leaves the database and Prisma disagreeing about
what is applied.

Repeat the command to go back further — deliberately, one release at a time.

### Why one batch rather than a transaction opened by the script

Half the `down.sql` files carry their own `BEGIN;`/`COMMIT;`, because the fallback path
is applying one by hand through `psql`, which is in autocommit — and a down migration
that half-applies through `psql` is the worse failure. Feeding such a file into a
transaction the script had already opened made the file's `COMMIT` close it early and
left the bookkeeping delete outside, which is the defect TAR-346 fixed. The batch works
for both kinds of file because of how Postgres treats a multi-statement simple query:

- it opens an **implicit** transaction block for the batch, which covers a `down.sql`
  that manages no transaction of its own;
- a `BEGIN` inside that implicit block **converts** it to an explicit one rather than
  opening a second, so a `BEGIN;`-carrying file commits the delete along with its own
  statements.

Both hold only while a file's transaction control is either nothing at all or a single
outermost `BEGIN;` … `COMMIT;` with nothing after it. `db:check-migrations` fails on
anything else, and `db:rollback` refuses to run it. The cost of that rule is that a
`down.sql` cannot contain a statement Postgres forbids inside a transaction —
`CREATE INDEX CONCURRENTLY`, `VACUUM`. None does, and the up migrations cannot either
because Prisma wraps those in one transaction too; if one ever has to, the answer is a
change to the runner, not a file that quietly commits half-way through. `db-rollback.int-spec.ts` drives the
real script against fixture `down.sql` files of both shapes and proves the two claims
that matter: the delete is visible from inside the down migration, and a `down.sql` that
raises part-way through leaves neither the schema change nor the delete applied.

## Rolling back a release

Roll the **application** back first, then the schema only if you have to:

1. Render → the service → **Deploys** → roll back to the previous successful deploy.
2. Only if the schema itself is the problem: `db:rollback --confirm` against that
   environment.

That order works because migrations are additive within a release, so the previous
application version still runs against the new schema. It is also why the additive
rule matters more than the rollback script does — a release that is additive can be
undone by redeploying alone, with no data at risk.

A `down.sql` that drops a column or table **destroys the data in it**. Where that is
unacceptable, the answer is not a better `down.sql`; it is expand → migrate →
contract, so the destructive step lands in its own separately deployable migration.

## Before shipping a schema change

Confirm it applies to a brand-new database, to a database one version behind, and
twice in a row — and that `db:rollback --confirm` followed by `db:migrate:deploy`
returns the schema to where it started.
