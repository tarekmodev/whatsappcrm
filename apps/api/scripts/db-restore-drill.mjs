#!/usr/bin/env node
/**
 * Takes a logical backup of a database, restores it into a separate target, and
 * proves the two are the same database.
 *
 * This is the executable half of "an untested backup is not a backup" (TAR-43).
 * Render's managed Postgres takes the backups (docs/runbooks/backups.md); what
 * no provider can tell you is whether the thing it hands back still holds your
 * schema, your row-level security policies and your rows. That is what this
 * checks, and it is deliberately a *comparison* rather than a smoke test: a
 * restore that comes up but is missing four policies is the failure mode worth
 * catching, and "the app started" would not catch it.
 *
 *   pnpm db:restore-drill                      # local, against the compose stack
 *   pnpm db:restore-drill -- --source-url ...  # any other non-production source
 *
 * What it compares, source against restored: the applied migration history and
 * its checksums, every column, index, constraint, enum label, function, table
 * grant, the RLS enabled/forced flags, every policy predicate, and an exact
 * row count per table. Any difference is a non-zero exit and a printed diff.
 *
 * Two things it deliberately does not do:
 *
 *   - It never touches the source beyond reading. The only writes are to the
 *     target database, which it creates and drops itself.
 *   - It refuses a target that is not obviously scratch, and refuses one that
 *     looks like production even under --force-target. A drill that can be
 *     pointed at production by a mistyped argument is a worse risk than the one
 *     it exists to retire. See `assertTargetIsScratch`.
 *
 * Run it as the database owner or a BYPASSRLS role. Row counts are the only
 * check that reads user data, and RLS would otherwise filter them to nothing on
 * both sides — see `requireUnfilteredReads`.
 *
 * Client binaries: pg_dump/pg_restore/psql must match or exceed the *server*
 * major version, and this box may not have them at all. If they are on PATH
 * they are used; otherwise the script runs them in a throwaway container
 * (`--client docker`, the default fallback). Pin `--client-image` to the major
 * version of whatever you are dumping — Render runs 16, the compose stack 17.
 *
 * Uses `pg` directly rather than a Prisma client, for the same reason
 * db-rollback.mjs does: an operational tool should not depend on a generated
 * client existing.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DRILL_DIR = join(REPO_ROOT, '.drill');

/** Same key family as db-rollback.mjs, different value: these must not collide. */
const ADVISORY_LOCK_KEY = 4_121_043;

/**
 * A target database whose name does not end in this is assumed to be somebody's
 * real database until proven otherwise. `--force-target` is the proof.
 */
const SCRATCH_SUFFIX = '_restore_drill';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    sourceUrl: process.env.DATABASE_URL ?? '',
    targetUrl: '',
    client: 'auto',
    // The major the compose stack and Render both run. `pg_dump` refuses to dump
    // a server newer than itself, so this tracks docker-compose.yml.
    clientImage: 'postgres:16-alpine',
    createTarget: true,
    forceTarget: false,
    keep: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value.`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--source-url':
        opts.sourceUrl = next();
        break;
      case '--target-url':
        opts.targetUrl = next();
        break;
      case '--client':
        opts.client = next();
        break;
      case '--client-image':
        opts.clientImage = next();
        break;
      // For a target you cannot create — a Render scratch instance is handed to
      // you already existing, and its user has no CREATEDB.
      case '--no-create-target':
        opts.createTarget = false;
        break;
      case '--force-target':
        opts.forceTarget = true;
        break;
      case '--keep':
        opts.keep = true;
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${arg}\nRun with --help.`);
    }
  }

  return opts;
}

function usage() {
  console.log(
    [
      'Back up a database, restore it elsewhere, and diff the two.',
      '',
      '  --source-url URL     Database to back up. Default: $DATABASE_URL. Read-only.',
      '  --target-url URL     Where to restore. Default: the source server, database',
      `                       <source>${SCRATCH_SUFFIX}.`,
      '  --client MODE        path | docker | auto (default). How to reach pg_dump.',
      '  --client-image IMG   Image for --client docker. Default postgres:16-alpine,',
      '                       the major both the compose stack and Render run.',
      '  --no-create-target   Target already exists and is empty; do not drop/create it.',
      `  --force-target       Allow a target not named *${SCRATCH_SUFFIX}. Never allows`,
      '                       a target that looks like production.',
      '  --keep               Keep the dump file and the restored database.',
      '',
      'Exits non-zero on any difference between source and restored.',
    ].join('\n'),
  );
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Connection strings
// ---------------------------------------------------------------------------

/** Never print a connection string: it carries the password. */
function redact(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.username ? '***@' : ''}${parsed.host}${parsed.pathname}`;
  } catch {
    return '<unparseable connection string>';
  }
}

function databaseName(url) {
  return new URL(url).pathname.replace(/^\//, '');
}

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  // `?schema=public` is Prisma's, not libpq's, and pg_dump rejects it as an
  // unrecognised keyword. Every other query parameter (sslmode, and so on) is
  // libpq's and has to survive.
  parsed.searchParams.delete('schema');
  return parsed.toString();
}

/**
 * A container reaching a server on the host cannot use `localhost` — that is the
 * container. `host.docker.internal` is mapped back to the host below.
 */
function forContainer(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    parsed.hostname = 'host.docker.internal';
  }
  return parsed.toString();
}

function pgClientOptions(url) {
  const options = { connectionString: url };
  // Render terminates TLS with a certificate this script has no chain for, and
  // the alternative to accepting it is not verifying — it is not connecting.
  if (/sslmode=(require|prefer)/.test(url)) {
    options.ssl = { rejectUnauthorized: false };
  }
  return options;
}

// ---------------------------------------------------------------------------
// Running the client binaries
// ---------------------------------------------------------------------------

function run(command, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    if (input !== undefined) child.stdin.end(input);

    child.on('error', (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function onPath(binary) {
  const { code } = await run(binary, ['--version']);
  return code === 0;
}

/** Major version of the pg_dump on PATH, or null if there is not one. */
async function pathClientMajor() {
  const { code, stdout } = await run('pg_dump', ['--version']);
  if (code !== 0) return null;
  // "pg_dump (PostgreSQL) 16.13" — and on Debian, a trailing build suffix.
  const match = stdout.match(/\b(\d+)\.\d+/);
  return match ? Number(match[1]) : null;
}

/**
 * Returns a function that runs one of the Postgres client binaries, either from
 * PATH or inside a container. Container mode mounts the dump directory at
 * `/drill`, so callers refer to dump files by that path in both modes — the
 * returned runner rewrites paths and connection strings to match.
 *
 * `serverMajor` is why this is chosen after connecting rather than before:
 * pg_dump refuses to dump a server newer than itself, and the default runner
 * image on a CI box is routinely a major behind the compose stack. Finding that
 * out from a failed dump wastes the run; `auto` steps around it.
 */
async function makeClientRunner({ client, clientImage, serverMajor }) {
  let mode = client;

  if (client === 'auto') {
    const major = await pathClientMajor();
    mode = major === null || (serverMajor !== null && major < serverMajor) ? 'docker' : 'path';

    if (mode === 'docker' && major !== null) {
      console.log(
        `  note: pg_dump ${major} on PATH cannot dump a version ${serverMajor} server —\n` +
          `        using ${clientImage} instead. --client path to override.`,
      );
    }
  }

  if (mode === 'path') {
    return {
      mode,
      describe: 'pg_dump/pg_restore from PATH',
      run: (binary, args, url) =>
        run(
          binary,
          args.map((a) => a.replace('/drill/', `${DRILL_DIR}/`)).concat(url ? [url] : []),
        ),
    };
  }

  if (mode !== 'docker') fail(`--client must be path, docker or auto (got "${mode}").`);

  if (!(await onPath('docker'))) {
    fail(
      'Neither pg_dump nor docker is available.\n' +
        'Install the PostgreSQL client tools, or Docker, and run this again.',
    );
  }

  return {
    mode,
    describe: `${clientImage} (container)`,
    run: (binary, args, url) =>
      run('docker', [
        'run',
        '--rm',
        '--add-host=host.docker.internal:host-gateway',
        '-v',
        `${DRILL_DIR}:/drill`,
        '--entrypoint',
        binary,
        clientImage,
        ...args,
        ...(url ? [forContainer(url)] : []),
      ]),
  };
}

// ---------------------------------------------------------------------------
// Fingerprints — what "the same database" means, stated as SQL
// ---------------------------------------------------------------------------

/**
 * Each entry is one dimension the restored database has to match on. They are
 * separate rather than one query so a failure names the thing that is missing.
 */
const FINGERPRINTS = [
  {
    name: 'migrations applied',
    sql: `SELECT migration_name, checksum, applied_steps_count
            FROM "_prisma_migrations"
           WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
           ORDER BY migration_name`,
  },
  {
    name: 'columns',
    sql: `SELECT table_name, column_name, data_type, udt_name, is_nullable,
                 column_default, character_maximum_length, numeric_precision
            FROM information_schema.columns
           WHERE table_schema = 'public'
           ORDER BY table_name, column_name`,
  },
  {
    name: 'indexes',
    sql: `SELECT indexname, indexdef
            FROM pg_indexes
           WHERE schemaname = 'public'
           ORDER BY indexname`,
  },
  {
    name: 'constraints',
    sql: `SELECT conrelid::regclass::text AS table_name, conname,
                 pg_get_constraintdef(oid) AS definition, convalidated
            FROM pg_constraint
           WHERE connamespace = 'public'::regnamespace
           ORDER BY 1, 2`,
  },
  {
    name: 'enum labels',
    sql: `SELECT t.typname, e.enumlabel, e.enumsortorder
            FROM pg_type t
            JOIN pg_enum e ON e.enumtypid = t.oid
           WHERE t.typnamespace = 'public'::regnamespace
           ORDER BY t.typname, e.enumsortorder`,
  },
  {
    name: 'functions',
    sql: `SELECT proname, pg_get_function_identity_arguments(oid) AS args,
                 prosecdef, provolatile
            FROM pg_proc
           WHERE pronamespace = 'public'::regnamespace
           ORDER BY proname, 2`,
  },
  {
    // The tenant isolation guarantee is these two booleans. A restore that drops
    // FORCE ROW LEVEL SECURITY silently turns every tenant's data into
    // everyone's, and nothing above this line would notice.
    name: 'row-level security flags',
    sql: `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
           ORDER BY c.relname`,
  },
  {
    name: 'row-level security policies',
    sql: `SELECT tablename, policyname, permissive, roles::text, cmd, qual, with_check
            FROM pg_policies
           WHERE schemaname = 'public'
           ORDER BY tablename, policyname`,
  },
  {
    // Ownership and GRANTs are cluster state, not schema state: pg_dump carries
    // the ACLs but not the roles they name. If the target cluster is missing
    // whatsappcrm_app, this is the line that says so.
    name: 'table grants',
    sql: `SELECT table_name, grantee, privilege_type
            FROM information_schema.role_table_grants
           WHERE table_schema = 'public'
           ORDER BY table_name, grantee, privilege_type`,
  },
  {
    name: 'extensions',
    sql: `SELECT extname FROM pg_extension ORDER BY extname`,
  },
];

async function fingerprint(client) {
  const result = {};
  for (const { name, sql } of FINGERPRINTS) {
    // A source with no migration history at all is a misconfiguration worth
    // reporting as itself rather than as a missing relation.
    const { rows } = await client.query(sql).catch((error) => {
      if (error.code === '42P01') return { rows: [`<relation missing: ${error.message}>`] };
      throw error;
    });
    result[name] = rows;
  }
  return result;
}

/**
 * Exact counts, not the planner's estimate from pg_class.reltuples: a restore
 * has fresh statistics and the estimate would agree with the source by accident
 * or disagree with it by accident. This is O(rows) per table and the reason the
 * drill is a drill and not something that runs on every deploy.
 */
async function rowCounts(client, label) {
  const { rows: tables } = await client.query(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  );

  const counts = {};
  for (const { relname } of tables) {
    const { rows } = await client
      .query(`SELECT count(*)::bigint AS n FROM "public"."${relname}"`)
      .catch((error) => {
        if (error.code === '42501') {
          fail(
            `Row-level security applies to "${relname}" on the ${label} connection, so a\n` +
              'count taken here would be a count of what this role may see rather than of\n' +
              'what the database holds — with no app.tenant_id set, that is zero on both\n' +
              'sides and the drill would agree with itself about nothing.\n\n' +
              'Re-run as the database owner or a role with BYPASSRLS. On Render that is\n' +
              'the instance owner from the dashboard, not the application role.',
          );
        }
        throw error;
      });
    counts[relname] = Number(rows[0].n);
  }
  return counts;
}

/**
 * Row counts are the one check here that reads user data rather than the
 * catalog, which makes them the one check RLS can silently empty: every
 * tenant-scoped policy matches nothing when `app.tenant_id` is unset, so source
 * and restored both report zero, agree, and the drill prints DRILL PASSED
 * having compared nothing. Locally that never shows, because the compose stack
 * connects as the superuser; on Render, or anywhere else the drill is run as
 * the application role, it is the default outcome.
 *
 * `row_security = off` turns that from a silent pass into a hard error:
 * Postgres raises 42501 rather than returning a filtered row set for any table
 * whose policies would apply. A superuser or BYPASSRLS role is unaffected and
 * sees every row either way — which is what this drill needs.
 */
async function requireUnfilteredReads(client) {
  await client.query('SET row_security = off');
  const {
    rows: [{ unfiltered }],
  } = await client.query(
    'SELECT rolsuper OR rolbypassrls AS unfiltered FROM pg_roles WHERE rolname = current_user',
  );
  return Boolean(unfiltered);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

/** First few differing entries, so a failure is actionable without a second run. */
function firstDifferences(a, b, limit = 5) {
  const left = JSON.stringify(a, null, 0);
  const right = JSON.stringify(b, null, 0);
  if (left === right) return [];

  const lines = [];
  const seen = new Set();
  const key = (row) => JSON.stringify(row);

  const rightKeys = new Set((b ?? []).map(key));
  for (const row of a ?? []) {
    if (!rightKeys.has(key(row)) && !seen.has(key(row))) {
      seen.add(key(row));
      lines.push(`  only in source:   ${key(row)}`);
      if (lines.length >= limit) return lines;
    }
  }

  const leftKeys = new Set((a ?? []).map(key));
  for (const row of b ?? []) {
    if (!leftKeys.has(key(row)) && !seen.has(key(row))) {
      seen.add(key(row));
      lines.push(`  only in restored: ${key(row)}`);
      if (lines.length >= limit) return lines;
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertTargetIsScratch({ sourceUrl, targetUrl, forceTarget }) {
  const source = new URL(sourceUrl);
  const target = new URL(targetUrl);

  if (
    source.host === target.host &&
    databaseName(source.toString()) === databaseName(target.toString())
  ) {
    fail('Target is the source database. The drill restores over its target — refusing.');
  }

  const name = databaseName(targetUrl);

  // Above the --force-target escape hatch on purpose. The flag exists to allow a
  // target the naming convention does not cover (a Render scratch instance comes
  // with its own name); it is not a way to aim the drill at production, and the
  // mistyped target the flag makes reachable is exactly the one worth catching.
  // This guard has no override.
  if (/prod/i.test(name) || /prod/i.test(target.host)) {
    fail(`Target "${redact(targetUrl)}" looks like production. Refusing.`);
  }

  if (forceTarget) return;

  if (!name.endsWith(SCRATCH_SUFFIX)) {
    fail(
      `Target database "${name}" is not named *${SCRATCH_SUFFIX}, so this script treats\n` +
        'it as a real database. The drill DROPs its target. Rename the target, or pass\n' +
        '--force-target if you are certain.',
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.sourceUrl) {
    fail('No source database. Set DATABASE_URL or pass --source-url.');
  }

  opts.sourceUrl = withDatabase(opts.sourceUrl, databaseName(opts.sourceUrl));
  if (!opts.targetUrl) {
    opts.targetUrl = withDatabase(
      opts.sourceUrl,
      `${databaseName(opts.sourceUrl)}${SCRATCH_SUFFIX}`,
    );
  } else {
    opts.targetUrl = withDatabase(opts.targetUrl, databaseName(opts.targetUrl));
  }

  assertTargetIsScratch(opts);

  mkdirSync(DRILL_DIR, { recursive: true });

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const dumpName = `${databaseName(opts.sourceUrl)}-${stamp}.dump`;
  const dumpPath = join(DRILL_DIR, dumpName);

  console.log('Restore drill');
  console.log(`  started   ${startedAt.toISOString()}`);
  console.log(`  source    ${redact(opts.sourceUrl)}`);
  console.log(`  target    ${redact(opts.targetUrl)}`);
  console.log('');

  // --- 1. Read the source -------------------------------------------------
  const source = new Client(pgClientOptions(opts.sourceUrl));
  await source.connect();

  let sourceFingerprint;
  let sourceCounts;
  let sourceVersion;
  let bypassesRls;
  try {
    // Shared, not exclusive: this is a read. It exists so two drills against
    // one source do not interleave a dump with the other's target creation.
    await source.query('SELECT pg_advisory_lock_shared($1)', [ADVISORY_LOCK_KEY]);
    ({
      rows: [{ version: sourceVersion }],
    } = await source.query('SELECT version()'));
    bypassesRls = await requireUnfilteredReads(source);
    sourceFingerprint = await fingerprint(source);
    sourceCounts = await rowCounts(source, 'source');
  } finally {
    await source.end();
  }

  const sourceRows = Object.values(sourceCounts).reduce((a, b) => a + b, 0);
  const serverMajor = Number(sourceVersion.match(/PostgreSQL (\d+)/)?.[1] ?? 0) || null;
  console.log(`  source is ${sourceVersion.split(' ').slice(0, 2).join(' ')}`);
  console.log(`  ${Object.keys(sourceCounts).length} tables, ${sourceRows} rows across them`);
  console.log(
    `  counts    unfiltered (${bypassesRls ? 'superuser/BYPASSRLS role' : 'row_security = off'})`,
  );

  if (sourceRows === 0) {
    console.warn(
      '\n  ! The source holds no rows. The drill will still verify the schema, but a\n' +
        '    zero-row restore proves nothing about data. Load rows first — a seeded\n' +
        '    database, or `pnpm db:canary` for the minimum that makes this mean something.',
    );
  }

  const client = await makeClientRunner({ ...opts, serverMajor });
  console.log(`  client    ${client.describe}\n`);

  // --- 2. Dump ------------------------------------------------------------
  const dumpStarted = Date.now();
  const dump = await client.run(
    'pg_dump',
    ['--format=custom', '--compress=6', '--file', `/drill/${dumpName}`, '--dbname'],
    opts.sourceUrl,
  );
  if (dump.code !== 0) {
    fail(`pg_dump failed (exit ${dump.code}):\n${dump.stderr}`);
  }
  const dumpSeconds = ((Date.now() - dumpStarted) / 1000).toFixed(1);
  console.log(`  dumped in ${dumpSeconds}s → .drill/${dumpName}`);

  // --- 3. Create the target ----------------------------------------------
  if (opts.createTarget) {
    // DROP/CREATE DATABASE cannot run inside a transaction and cannot run from
    // a connection to the database being dropped, so this goes through the
    // maintenance database on the same server.
    const maintenance = new Client(pgClientOptions(withDatabase(opts.targetUrl, 'postgres')));
    await maintenance.connect();
    try {
      const name = databaseName(opts.targetUrl);
      await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await maintenance.query(`CREATE DATABASE "${name}"`);
      console.log(`  created empty target database "${name}"`);
    } finally {
      await maintenance.end();
    }
  }

  // --- 4. Restore ---------------------------------------------------------
  const restoreStarted = Date.now();
  const restore = await client.run(
    'pg_restore',
    // Ownership and privileges are kept on purpose: dropping them would make
    // the "table grants" fingerprint below pass vacuously, and a restore that
    // loses the app role's GRANTs is exactly the outcome worth catching.
    ['--single-transaction', '--exit-on-error', `/drill/${dumpName}`, '--dbname'],
    opts.targetUrl,
  );
  const restoreSeconds = ((Date.now() - restoreStarted) / 1000).toFixed(1);

  if (restore.code !== 0) {
    console.error(`\npg_restore failed (exit ${restore.code}):\n${restore.stderr}`);
    fail('RESTORE FAILED — the backup did not come back. Nothing was compared.');
  }
  console.log(`  restored in ${restoreSeconds}s`);
  if (restore.stderr.trim()) {
    console.log(`  pg_restore warnings:\n${indent(restore.stderr.trim())}`);
  }

  // --- 5. Compare ---------------------------------------------------------
  const target = new Client(pgClientOptions(opts.targetUrl));
  await target.connect();
  let targetFingerprint;
  let targetCounts;
  try {
    await requireUnfilteredReads(target);
    targetFingerprint = await fingerprint(target);
    targetCounts = await rowCounts(target, 'restored');
  } finally {
    await target.end();
  }

  console.log('\n  comparison');
  const failures = [];

  for (const { name } of FINGERPRINTS) {
    const a = sourceFingerprint[name];
    const b = targetFingerprint[name];
    const same = digest(a) === digest(b);
    console.log(
      `    ${same ? 'ok  ' : 'FAIL'}  ${name.padEnd(28)} ${String(a.length).padStart(5)} rows  ${digest(a)}${same ? '' : ` vs ${digest(b)}`}`,
    );
    if (!same) failures.push({ name, lines: firstDifferences(a, b) });
  }

  const countsSame = digest(sourceCounts) === digest(targetCounts);
  console.log(
    `    ${countsSame ? 'ok  ' : 'FAIL'}  ${'row counts'.padEnd(28)} ${String(sourceRows).padStart(5)} rows  ${digest(sourceCounts)}${countsSame ? '' : ` vs ${digest(targetCounts)}`}`,
  );
  if (!countsSame) {
    const lines = [];
    for (const table of new Set([...Object.keys(sourceCounts), ...Object.keys(targetCounts)])) {
      if (sourceCounts[table] !== targetCounts[table]) {
        lines.push(
          `  ${table}: source ${sourceCounts[table] ?? '-'}, restored ${targetCounts[table] ?? '-'}`,
        );
      }
    }
    failures.push({ name: 'row counts', lines });
  }

  // --- 6. Clean up --------------------------------------------------------
  if (!opts.keep) {
    rmSync(dumpPath, { force: true });
    if (opts.createTarget) {
      const maintenance = new Client(pgClientOptions(withDatabase(opts.targetUrl, 'postgres')));
      await maintenance.connect();
      try {
        await maintenance.query(
          `DROP DATABASE IF EXISTS "${databaseName(opts.targetUrl)}" WITH (FORCE)`,
        );
      } finally {
        await maintenance.end();
      }
    }
    console.log('\n  cleaned up the dump file and the restored database (--keep to retain)');
  } else {
    console.log(`\n  kept .drill/${dumpName} and "${databaseName(opts.targetUrl)}"`);
  }

  // --- 7. Verdict ---------------------------------------------------------
  const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);

  if (failures.length > 0) {
    console.error('\nDRILL FAILED — the restored database is not the source database.\n');
    for (const { name, lines } of failures) {
      console.error(`  ${name}`);
      for (const line of lines) console.error(`  ${line}`);
      console.error('');
    }
    process.exit(1);
  }

  console.log(
    `\nDRILL PASSED — restored ${Object.keys(sourceCounts).length} tables and ${sourceRows} rows,\n` +
      `identical on all ${FINGERPRINTS.length + 1} checks. Dump ${dumpSeconds}s, restore ${restoreSeconds}s, ${elapsed}s total.`,
  );
  console.log('Record the result on TAR-43 and in docs/runbooks/backups.md.');
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
