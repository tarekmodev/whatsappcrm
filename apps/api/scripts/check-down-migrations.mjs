#!/usr/bin/env node
/**
 * Fails when a migration cannot be undone.
 *
 * Prisma does not generate down migrations, and TAR-34 requires migrations to be
 * reversible. The convention that closes that gap is a hand-written `down.sql`
 * beside every `migration.sql` — and a convention nothing checks is a convention
 * that lasts until the first busy afternoon, so CI checks it.
 *
 * See docs/runbooks/migrations.md for how to write one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function isMissingDownMigration(directory) {
  const path = join(MIGRATIONS_DIR, directory, 'down.sql');

  try {
    return readFileSync(path, 'utf8').trim().length === 0;
  } catch {
    return true;
  }
}

const migrations = listMigrationDirectories();
const offenders = migrations.filter(isMissingDownMigration);

if (offenders.length > 0) {
  console.error(
    `Missing or empty down.sql in ${offenders.length} migration(s):\n` +
      offenders.map((name) => `  - prisma/migrations/${name}/down.sql`).join('\n') +
      '\n\nCreate migrations with `pnpm --filter @whatsappcrm/api db:migrate --name <name>`,\n' +
      'which writes the down.sql for you. See docs/runbooks/migrations.md.',
  );
  process.exit(1);
}

console.log(`Checked ${migrations.length} migration(s): every one has a down.sql.`);
