#!/usr/bin/env node
/**
 * Fails when a migration cannot be undone, or cannot be undone atomically.
 *
 * Prisma does not generate down migrations, and TAR-34 requires migrations to be
 * reversible. The convention that closes that gap is a hand-written `down.sql`
 * beside every `migration.sql` — and a convention nothing checks is a convention
 * that lasts until the first busy afternoon, so CI checks it.
 *
 * It checks two things:
 *
 *   1. Every migration directory has a non-empty `down.sql`.
 *   2. That file either manages no transaction of its own, or wraps itself in a
 *      single outermost `BEGIN;` … `COMMIT;`. `db-rollback.mjs` sends the file
 *      and the `_prisma_migrations` delete as one batch, and those are the two
 *      shapes for which that is one transaction (TAR-346). A file that commits
 *      halfway through would leave the bookkeeping outside it — which is a
 *      2 a.m. discovery unless it is a pull-request one.
 *
 * See docs/runbooks/migrations.md for how to write one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeTransactionShape } from './lib/sql-transaction-shape.mjs';

const MIGRATIONS_DIR = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

function listMigrationDirectories() {
  try {
    return readdirSync(MIGRATIONS_DIR).filter((entry) =>
      statSync(join(MIGRATIONS_DIR, entry)).isDirectory(),
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      // No migrations yet. The schema's first migration arrives with TAR-39's
      // data model; until then there is nothing to check and that is not a failure.
      return [];
    }

    throw error;
  }
}

function readDownMigration(directory) {
  try {
    return readFileSync(join(MIGRATIONS_DIR, directory, 'down.sql'), 'utf8');
  } catch {
    return null;
  }
}

const migrations = listMigrationDirectories();
const missing = [];
const unsupported = [];

for (const name of migrations) {
  const sql = readDownMigration(name);

  if (sql === null || sql.trim().length === 0) {
    missing.push(name);
    continue;
  }

  const { problem } = describeTransactionShape(sql);

  if (problem) unsupported.push({ name, problem });
}

if (missing.length > 0) {
  console.error(
    `Missing or empty down.sql in ${missing.length} migration(s):\n` +
      missing.map((name) => `  - prisma/migrations/${name}/down.sql`).join('\n') +
      '\n\nGenerate one BEFORE running `pnpm db:migrate` — see the "Rolling a migration\n' +
      'back" section of README.md. Run the diff afterwards and both sides are already\n' +
      'in sync, so it emits an empty migration that passes this check and reverses\n' +
      'nothing.',
  );
}

if (unsupported.length > 0) {
  console.error(
    `${unsupported.length} down.sql file(s) manage their transaction in a way\n` +
      '`pnpm db:rollback` cannot apply atomically:\n' +
      unsupported
        .map(({ name, problem }) => `  - prisma/migrations/${name}/down.sql\n      ${problem}`)
        .join('\n') +
      '\n\nA down.sql either manages no transaction at all — `db:rollback` supplies one —\n' +
      'or wraps itself in a single outermost BEGIN; … COMMIT; for the by-hand `psql`\n' +
      'path, with nothing after the COMMIT. Anything else splits the rollback across\n' +
      'two transactions and leaves the _prisma_migrations delete outside the one that\n' +
      'changed the schema.',
  );
}

if (missing.length > 0 || unsupported.length > 0) {
  process.exit(1);
}

console.log(
  `Checked ${migrations.length} migration(s): every one has a down.sql that can be rolled back atomically.`,
);
