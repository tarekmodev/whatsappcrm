#!/usr/bin/env node
/**
 * Rolls the most recently applied migration back, using its hand-written
 * `down.sql`, and removes its bookkeeping row so `prisma migrate deploy` will
 * apply it again.
 *
 * This is the operational half of "migrations are reversible": the convention
 * enforced by `check-down-migrations.mjs` produces the SQL, and this runs it —
 * including the `_prisma_migrations` cleanup that is easy to forget when applying
 * a down migration by hand, and without which `migrate deploy` will never
 * re-apply it.
 *
 *   pnpm --filter @whatsappcrm/api db:rollback            # show the plan only
 *   pnpm --filter @whatsappcrm/api db:rollback --confirm  # actually roll back
 *
 * Rolling back one migration at a time is deliberate. A "roll back to version N"
 * flag reads as convenience and behaves as a way to drop four releases of tables
 * with one mistyped argument.
 *
 * ---------------------------------------------------------------------------
 * How the two halves are made atomic (TAR-346)
 * ---------------------------------------------------------------------------
 *
 * The schema change and the bookkeeping `DELETE` have to land together. A
 * failure between them leaves the schema rolled back while Prisma still records
 * the migration as applied, and `migrate deploy` then refuses to re-apply it —
 * the exact disagreement this script exists to prevent.
 *
 * It cannot get that by opening a transaction from the client. Ten of the
 * `down.sql` files carry their own `BEGIN;`/`COMMIT;`, correctly, because the
 * documented fallback is applying them by hand through `psql`, which is in
 * autocommit. Fed into a client-opened transaction, such a file's `COMMIT` ends
 * it early and the `DELETE` lands outside — which is what this script used to do.
 *
 * So the `DELETE` and the file go to the server as **one simple-query batch**,
 * and the batch's own transaction is the only one:
 *
 *   - Postgres opens an implicit transaction block for a multi-statement simple
 *     query, so a `down.sql` with no transaction control of its own is covered
 *     from the `DELETE` to the end of the batch.
 *   - A `BEGIN` inside that implicit block *converts* it to an explicit block
 *     rather than opening a second one, so for a `BEGIN;`-carrying file the
 *     `DELETE` is inside the transaction the file goes on to commit.
 *
 * Both hold only while the file's transaction control is nothing, or one
 * outermost `BEGIN` … `COMMIT`. `describeTransactionShape` is what says so, and
 * a file it cannot vouch for is refused rather than half-applied.
 *
 * Uses `pg` directly rather than a Prisma client: TAR-47's schema has no
 * `generator` block, so there is no generated client to import (TAR-49 owns
 * that), and a rollback runner should not be the reason one appears.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { describeTransactionShape } from './lib/sql-transaction-shape.mjs';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

/** Any value works as long as every runner uses the same one. */
const ADVISORY_LOCK_KEY = 4_121_041;

const confirmed = process.argv.includes('--confirm');

/**
 * `--migrations-dir <path>` exists so `db-rollback.int-spec.ts` can drive this
 * script — the real one, not a copy of its logic — against fixture `down.sql`
 * files of every shape, including ones that fail on purpose. Operationally it
 * has no use: the migrations that belong to a build ship with it, and this
 * defaults to them.
 */
function migrationsDirectory(argv) {
  const at = argv.indexOf('--migrations-dir');

  if (at === -1) return DEFAULT_MIGRATIONS_DIR;
  if (!argv[at + 1]) fail('--migrations-dir needs a path.');

  return argv[at + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set.');
  }

  const migrationsDir = migrationsDirectory(process.argv);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Two runners rolling back concurrently would each undo a different migration
    // and leave the schema somewhere neither of them expects.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    const applied = await client.query(
      `SELECT migration_name
         FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY finished_at DESC
        LIMIT 1`,
    );

    const target = applied.rows[0]?.migration_name;

    if (!target) {
      console.log('No applied migration to roll back.');
      return;
    }

    const downPath = join(migrationsDir, target, 'down.sql');

    if (!existsSync(downPath)) {
      fail(
        `Migration "${target}" has no down.sql, so it cannot be rolled back.\n` +
          'See the "Rolling a migration back" section of README.md.',
      );
    }

    const downSql = readFileSync(downPath, 'utf8');
    const { shape, problem } = describeTransactionShape(downSql);

    // Refusing is the whole point: running it anyway is what produces a schema
    // that disagrees with `_prisma_migrations`, and that is worse than not
    // running. `db:check-migrations` fails on the same condition in CI, so a
    // file reaching this check is one that was written after it was merged.
    if (problem) {
      fail(
        `Refusing to roll back "${target}": ${problem}.\n\n` +
          `  ${downPath}\n\n` +
          'A down.sql must either manage no transaction at all, or wrap itself in a\n' +
          'single outermost BEGIN; … COMMIT;. Anything else cannot be applied together\n' +
          'with the _prisma_migrations delete, so a failure part-way through would\n' +
          'leave the schema and the migration history disagreeing.',
      );
    }

    if (!confirmed) {
      console.log(
        `Would roll back "${target}" by running:\n  ${downPath}\n\n` +
          'Re-run with --confirm to apply it. Nothing has been changed.',
      );
      return;
    }

    console.log(`Rolling back "${target}" (${shape} down.sql)...`);

    // One batch, one transaction — see the header. The migration name is
    // interpolated rather than bound because a parameterised query goes over the
    // extended protocol, which carries exactly one statement; `escapeLiteral` is
    // the same quoting the driver would have applied.
    await client.query(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = ${client.escapeLiteral(target)};\n` +
        downSql,
    );

    console.log(`Rolled back "${target}". "pnpm db:migrate:deploy" will re-apply it.`);
  } catch (error) {
    // Postgres has already rolled the batch back. This clears the aborted
    // transaction a `BEGIN;`-carrying file leaves open, so the unlock below can
    // still run on the same connection.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

await main();
