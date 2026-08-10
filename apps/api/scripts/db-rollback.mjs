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
 * Uses `pg` directly rather than a Prisma client: TAR-47's schema has no
 * `generator` block, so there is no generated client to import (TAR-49 owns
 * that), and a rollback runner should not be the reason one appears.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

/** Any value works as long as every runner uses the same one. */
const ADVISORY_LOCK_KEY = 4_121_041;

const confirmed = process.argv.includes('--confirm');

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set.');
  }

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

    const downPath = join(MIGRATIONS_DIR, target, 'down.sql');

    if (!existsSync(downPath)) {
      fail(
        `Migration "${target}" has no down.sql, so it cannot be rolled back.\n` +
          'See the "Rolling a migration back" section of README.md.',
      );
    }

    if (!confirmed) {
      console.log(
        `Would roll back "${target}" by running:\n  ${downPath}\n\n` +
          'Re-run with --confirm to apply it. Nothing has been changed.',
      );
      return;
    }

    console.log(`Rolling back "${target}"...`);

    // The whole down migration and its bookkeeping row go together: a rollback
    // that half-applies is worse than one that does not run.
    await client.query('BEGIN');
    await client.query(readFileSync(downPath, 'utf8'));
    await client.query('DELETE FROM "_prisma_migrations" WHERE migration_name = $1', [target]);
    await client.query('COMMIT');

    console.log(`Rolled back "${target}". "pnpm db:migrate:deploy" will re-apply it.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

await main();
