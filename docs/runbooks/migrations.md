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
migration directory has no `down.sql`, and it runs on every pull request — a
migration that cannot be undone cannot be merged.

To undo the most recently applied migration against any target:

```bash
export DATABASE_URL=...                               # read it back before continuing
pnpm --filter @whatsappcrm/api db:rollback            # prints the plan, changes nothing
pnpm --filter @whatsappcrm/api db:rollback --confirm  # runs it
```

It takes a Postgres advisory lock, runs that migration's `down.sql` and deletes its
`_prisma_migrations` row **in one transaction**, so a half-applied rollback is not a
state you can end up in. Removing that row is what lets `db:migrate:deploy` apply the
migration again; applying a `down.sql` by hand and forgetting it leaves the database
and Prisma disagreeing about what is applied.

Repeat the command to go back further — deliberately, one release at a time.

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
