#!/usr/bin/env node
/**
 * Creates the two application database roles and sets their passwords, in a
 * deployed environment.
 *
 * TAR-48 ships the role SQL and TAR-42 wires `pnpm db:roles` for local use, but
 * that script is `docker compose exec psql` — it only reaches a container on the
 * developer's machine. Nothing created the roles anywhere else, and since TAR-49
 * made `APP_DATABASE_URL` and `SYSTEM_DATABASE_URL` mandatory, a deployed API
 * cannot boot without them. This runs the same SQL over a normal connection so
 * the deploy hook can do it.
 *
 * Deliberately reuses `prisma/sql/*.sql` unchanged rather than restating the
 * grants: two copies of a security policy is how they drift apart.
 *
 *   DATABASE_URL              the migration owner — the only role that may create roles
 *   APP_DATABASE_PASSWORD     password for whatsappcrm_app
 *   SYSTEM_DATABASE_PASSWORD  password for whatsappcrm_system
 *
 * Idempotent: the SQL uses IF NOT EXISTS / re-grants, and ALTER ROLE ... PASSWORD
 * is a set, not an append. Safe to run on every deploy, which is the point.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const ROLES_SQL = fileURLToPath(new URL('../prisma/sql/app-roles.sql', import.meta.url));

/** Mirrors the role names in `prisma/sql/app-roles.sql`. */
const ROLE_PASSWORD_VARIABLES = [
  { role: 'whatsappcrm_app', variable: 'APP_DATABASE_PASSWORD' },
  { role: 'whatsappcrm_system', variable: 'SYSTEM_DATABASE_PASSWORD' },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Strips psql meta-commands so the file can run through a driver.
 *
 * `app-roles.sql` is written for psql and currently uses only `\set` and
 * `\echo` — control and output, no statements. `pg` sends the rest as one simple
 * query, which Postgres wraps in an implicit transaction, so an error still
 * aborts the whole file exactly as `ON_ERROR_STOP` intends.
 *
 * This holds only while the file stays free of `\gexec` and friends, which
 * generate SQL and have no driver equivalent. If one is ever added, this script
 * has to change with it — hence the loud failure below rather than a silent skip.
 */
function toDriverSql(sql) {
  const lines = sql.split(/\r?\n/);
  const executable = [];

  for (const line of lines) {
    const meta = /^\s*\\(\w+)\s*(.*)$/.exec(line);

    if (!meta) {
      executable.push(line);
      continue;
    }

    const [, command, argument] = meta;

    if (command === 'echo') {
      // Keep the progress output the file was written to produce.
      console.log(argument.replace(/^'|'$/g, ''));
    } else if (command !== 'set') {
      fail(
        `app-roles.sql uses the psql meta-command \\${command}, which cannot run through a driver.\n` +
          'Update apps/api/scripts/provision-roles.mjs, or keep the file driver-executable.',
      );
    }

    executable.push('');
  }

  return executable.join('\n');
}

async function main() {
  if (!process.env.DATABASE_URL) {
    fail(
      'DATABASE_URL is not set. It is the migration owner and the only role that may create roles.',
    );
  }

  const missing = ROLE_PASSWORD_VARIABLES.filter(({ variable }) => !process.env[variable]);

  if (missing.length > 0) {
    fail(
      `Missing ${missing.map(({ variable }) => variable).join(' and ')}.\n` +
        'Set them in this environment before deploying — see docs/runbooks/environments.md.',
    );
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log('Applying prisma/sql/app-roles.sql...');
    await client.query(toDriverSql(readFileSync(ROLES_SQL, 'utf8')));

    for (const { role, variable } of ROLE_PASSWORD_VARIABLES) {
      // The role name is a constant from this file, never input, so quoting it
      // into the statement cannot be injection. The password is parameterised
      // through `format` server-side rather than concatenated, and is never
      // logged.
      await client.query('SELECT set_config($1, $2, false)', [
        'whatsappcrm.pwd',
        process.env[variable],
      ]);
      await client.query(
        `DO $$ BEGIN
           EXECUTE format('ALTER ROLE ${role} LOGIN PASSWORD %L', current_setting('whatsappcrm.pwd'));
         END $$;`,
      );
      console.log(`Set LOGIN and password for ${role}.`);
    }

    console.log('Roles provisioned.');
  } finally {
    await client.end();
  }
}

await main();
