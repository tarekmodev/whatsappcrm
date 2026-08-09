#!/usr/bin/env node
/**
 * Creates a migration *and* its `down.sql`, in one command.
 *
 *   pnpm --filter @whatsappcrm/api db:migrate --name add_conversation_status
 *
 * The order matters and is easy to get wrong by hand: the down migration is the
 * diff from the **new** datamodel back to the **current database**, so it has to
 * be captured before `migrate dev` applies anything. Run the diff afterwards and
 * it reports no changes — the two sides are in sync by then — leaving an empty
 * `down.sql` that looks correct and reverses nothing.
 *
 * Wrapping it removes that trap, and CI still enforces the result
 * (`db:check-migrations`) for migrations written any other way.
 *
 * Local only: it calls `prisma migrate dev`, which may reset the database.
 * Deployed environments run `db:deploy`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const MIGRATIONS_DIR = fileURLToPath(new URL('../prisma/migrations', import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));

function prismaCliPath() {
  const manifestPath = require.resolve('prisma/package.json');
  const manifest = require('prisma/package.json');
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.prisma;

  return join(dirname(manifestPath), entry);
}

function prisma(args, options = {}) {
  try {
    return execFileSync(process.execPath, [prismaCliPath(), ...args], {
      stdio: options.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      encoding: 'utf8',
    });
  } catch {
    // Prisma has already explained itself on stderr; a Node stack trace on top of
    // that buries the part worth reading.
    fail(`\nprisma ${args[0]} ${args[1]} failed — see the output above.`);
  }
}

/** Directories only — Prisma also keeps `migration_lock.toml` in here. */
function migrationDirectories() {
  if (!existsSync(MIGRATIONS_DIR)) {
    return [];
  }

  return readdirSync(MIGRATIONS_DIR).filter((entry) =>
    statSync(join(MIGRATIONS_DIR, entry)).isDirectory(),
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const nameFlag = process.argv.indexOf('--name');
const name = nameFlag === -1 ? undefined : process.argv[nameFlag + 1];

if (!name) {
  fail('Usage: pnpm --filter @whatsappcrm/api db:migrate --name <migration_name>');
}

if (!process.env.DATABASE_URL) {
  fail('DATABASE_URL is not set. Start the local database first.');
}

// Captured first: from the new datamodel back to what the database currently is.
const downSql = prisma(
  [
    'migrate',
    'diff',
    '--from-schema-datamodel',
    SCHEMA_PATH,
    '--to-schema-datasource',
    SCHEMA_PATH,
    '--script',
  ],
  { capture: true },
);

const before = new Set(migrationDirectories());

prisma(['migrate', 'dev', '--name', name, '--schema', SCHEMA_PATH]);

const created = migrationDirectories().filter((entry) => !before.has(entry));

if (created.length === 0) {
  console.log('No schema changes to migrate; nothing was created.');
  process.exit(0);
}

for (const directory of created) {
  const path = join(MIGRATIONS_DIR, directory, 'down.sql');
  writeFileSync(path, downSql, 'utf8');
  console.log(`Wrote ${path}`);
}

console.log(
  '\nRead the down.sql before committing — a generated rollback will happily DROP a table.',
);
