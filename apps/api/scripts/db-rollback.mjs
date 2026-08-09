#!/usr/bin/env node
/**
 * Rolls the most recently applied migration back, using its hand-written
 * `down.sql`, and removes its bookkeeping row so `prisma migrate deploy` will
 * apply it again.
 *
 * This is the operational half of "migrations are reversible": the convention
 * enforced by `check-down-migrations.mjs` produces the SQL, and this runs it.
 *
 *   pnpm --filter @whatsappcrm/api db:rollback            # show the plan only
 *   pnpm --filter @whatsappcrm/api db:rollback --confirm  # actually roll back
 *
 * Rolling back one migration at a time is deliberate. A "roll back to version N"
 * flag reads as convenience and behaves as a way to drop four releases of tables
 * with one mistyped argument.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const require = createRequire(import.meta.url);

/**
 * Resolved from the package's own `bin` entry rather than a hardcoded path —
 * pnpm's store layout is not somewhere to hardcode a relative path into.
 */
function prismaCliPath() {
  const manifestPath = require.resolve('prisma/package.json');
  const manifest = require('prisma/package.json');
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.prisma;

  return join(dirname(manifestPath), entry);
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../prisma/migrations', import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));

/** Any value works as long as every runner uses the same one. */
const ADVISORY_LOCK_KEY = 4_121_041;

const confirmed = process.argv.includes('--confirm');

async function main() {
  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set.');
  }

  const prisma = new PrismaClient();

  try {
    // Two runners rolling back concurrently would each undo a different migration
    // and leave the schema somewhere neither of them expects.
    await prisma.$executeRaw`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;

    const applied = await prisma.$queryRaw`
      SELECT migration_name
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `;

    const target = applied[0]?.migration_name;

    if (!target) {
      console.log('No applied migration to roll back.');
      return;
    }

    const downPath = join(MIGRATIONS_DIR, target, 'down.sql');

    if (!existsSync(downPath)) {
      fail(
        `Migration "${target}" has no down.sql, so it cannot be rolled back.\n` +
          'See docs/runbooks/migrations.md.',
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

    // `prisma db execute` is the supported way to run a multi-statement SQL file;
    // the client's raw helpers accept one statement at a time.
    execFileSync(
      process.execPath,
      [prismaCliPath(), 'db', 'execute', '--file', downPath, '--schema', SCHEMA_PATH],
      { stdio: 'inherit' },
    );

    await prisma.$executeRaw`
      DELETE FROM "_prisma_migrations" WHERE migration_name = ${target}
    `;

    console.log(`Rolled back "${target}". "prisma migrate deploy" will re-apply it.`);
  } finally {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`.catch(
      () => undefined,
    );
    await prisma.$disconnect();
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

await main();
