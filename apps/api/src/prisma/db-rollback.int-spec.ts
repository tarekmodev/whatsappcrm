import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * TAR-346: `pnpm db:rollback --confirm` applies a `down.sql` and deletes the
 * migration's `_prisma_migrations` row **in one transaction**, which is what the
 * runbook promises and what the reversibility story in TAR-34 rests on.
 *
 * It runs the real `scripts/db-rollback.mjs` as a child process rather than
 * re-implementing what it does, because the defect this covers was not in any
 * one statement — it was in how the statements were sent. A test that composed
 * the batch itself would have passed against the broken version.
 *
 * The discriminating assertion is `bookkeeping_rows_visible`. Each fixture
 * `down.sql` records, from inside its own execution, how many
 * `_prisma_migrations` rows it can see for the migration being rolled back.
 * Zero means the delete had already happened *in the same transaction*. Before
 * TAR-346 the script opened a transaction from the client, a `BEGIN;`-carrying
 * file's `COMMIT` closed it early, and the delete ran afterwards in its own —
 * so this read one, and a crash in between left the schema reverted with Prisma
 * still recording the migration as applied.
 *
 * The other half is the induced failure: a `down.sql` whose last statement
 * raises must leave *neither* half applied — the table it dropped still there
 * and the bookkeeping row still there.
 *
 * Both are covered for the two file shapes in `prisma/migrations`: ten files
 * carry their own `BEGIN;`/`COMMIT;` (they are also applied by hand through
 * `psql`, which is in autocommit) and ten do not.
 *
 * ⚠️ Creates and drops a database of its own, `whatsappcrm_tar346_rollback`,
 * dropped before the run as well as after it so an interrupted run cleans up on
 * the next one. It never writes to the database `DATABASE_URL` names — that one
 * is only connected to in order to issue `CREATE DATABASE`.
 *
 * Prerequisites: `pnpm db:up`. The role in `DATABASE_URL` must be able to create
 * a database, which the Compose stack's owner role is.
 */

const SCRATCH_DATABASE = 'whatsappcrm_tar346_rollback';
const MIGRATION = '29991231000000_tar346_fixture';

const ROLLBACK_SCRIPT = join(__dirname, '../../scripts/db-rollback.mjs');

/** The columns `prisma migrate` creates, so the script reads the shape it will meet. */
const PRISMA_MIGRATIONS_DDL = `
  CREATE TABLE "_prisma_migrations" (
    id                  VARCHAR(36)  PRIMARY KEY,
    checksum            VARCHAR(64)  NOT NULL,
    finished_at         TIMESTAMPTZ,
    migration_name      VARCHAR(255) NOT NULL,
    logs                TEXT,
    rolled_back_at      TIMESTAMPTZ,
    started_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    applied_steps_count INTEGER      NOT NULL DEFAULT 0
  )`;

/**
 * The body of every fixture `down.sql`: note what the migration history looks
 * like from in here, then make one visible schema change.
 */
const DOWN_BODY = `
  CREATE TABLE "tar346_probe" AS
    SELECT (SELECT count(*)::int FROM "_prisma_migrations"
             WHERE migration_name = '${MIGRATION}') AS bookkeeping_rows_visible;

  DROP TABLE "tar346_target";
`;

/** Mirrors the ten `down.sql` files that manage no transaction of their own. */
const BARE_DOWN = `-- Reverses nothing; a fixture.
  SET LOCAL lock_timeout = '3s';
${DOWN_BODY}`;

/** Mirrors the ten that wrap themselves, for the by-hand `psql` path. */
const WRAPPED_DOWN = `-- Reverses nothing; a fixture. Mentions COMMIT; in prose on purpose.
BEGIN;

  SET LOCAL lock_timeout = '3s';
${DOWN_BODY}
COMMIT;
`;

const failing = (down: string): string =>
  down.replace('DROP TABLE "tar346_target";', 'DROP TABLE "tar346_target";\n  SELECT 1 / 0;');

function scratchUrl(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${SCRATCH_DATABASE}`;
  return url.toString();
}

async function withClient<T>(
  connectionString: string,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/** Runs the real CLI. Returns the exit status; 0 is success. */
function runRollback(migrationsDir: string): { status: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [ROLLBACK_SCRIPT, '--confirm', '--migrations-dir', migrationsDir],
      { env: { ...process.env, DATABASE_URL: scratchUrl() }, encoding: 'utf8', stdio: 'pipe' },
    );

    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };

    return {
      status: failure.status ?? -1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('db:rollback applies a down.sql and its bookkeeping delete in one transaction', () => {
  let fixtures: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set. Copy .env.example to .env and run `pnpm db:up`.');
    }

    await withClient(process.env.DATABASE_URL, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}" WITH (FORCE)`);
      await client.query(`CREATE DATABASE "${SCRATCH_DATABASE}"`);
    });

    fixtures = mkdtempSync(join(tmpdir(), 'tar346-'));
    mkdirSync(join(fixtures, MIGRATION));
  });

  afterAll(async () => {
    rmSync(fixtures, { recursive: true, force: true });

    await withClient(process.env.DATABASE_URL as string, (client) =>
      client.query(`DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}" WITH (FORCE)`),
    );
  });

  /** A database holding one applied migration and the table its down.sql drops. */
  beforeEach(async () => {
    await withClient(scratchUrl(), async (client) => {
      await client.query(
        'DROP TABLE IF EXISTS "tar346_probe", "tar346_target", "_prisma_migrations"',
      );
      await client.query(PRISMA_MIGRATIONS_DDL);
      await client.query(
        `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, applied_steps_count)
         VALUES ('tar346', 'not-checked-by-the-runner', $1, now(), 1)`,
        [MIGRATION],
      );
      await client.query('CREATE TABLE "tar346_target" (id INT)');
    });
  });

  function writeDown(sql: string): string {
    writeFileSync(join(fixtures, MIGRATION, 'down.sql'), sql, 'utf8');
    return fixtures;
  }

  async function stateAfterRollback(): Promise<{
    targetExists: boolean;
    bookkeepingRows: number;
    rowsVisibleToTheDownMigration: number | null;
  }> {
    return withClient(scratchUrl(), async (client) => {
      const { rows } = await client.query<{
        target_exists: boolean;
        probe_exists: boolean;
        bookkeeping_rows: string;
      }>(`
        SELECT to_regclass('public.tar346_target') IS NOT NULL AS target_exists,
               to_regclass('public.tar346_probe')  IS NOT NULL AS probe_exists,
               (SELECT count(*) FROM "_prisma_migrations")      AS bookkeeping_rows`);

      const [state] = rows;

      if (!state) throw new Error('The catalog query returned no row.');

      // Read separately: an unknown relation is a parse error, so the probe
      // cannot be a subquery in the statement that establishes it exists.
      const probe = state.probe_exists
        ? await client.query<{ bookkeeping_rows_visible: number }>(
            'SELECT bookkeeping_rows_visible FROM "tar346_probe"',
          )
        : null;

      return {
        targetExists: state.target_exists,
        bookkeepingRows: Number(state.bookkeeping_rows),
        rowsVisibleToTheDownMigration: probe?.rows[0]?.bookkeeping_rows_visible ?? null,
      };
    });
  }

  describe.each([
    ['a down.sql that carries its own BEGIN;/COMMIT;', WRAPPED_DOWN],
    ['a down.sql that manages no transaction', BARE_DOWN],
  ])('%s', (_name, down) => {
    it('drops the schema and the bookkeeping row together', async () => {
      const { status, output } = runRollback(writeDown(down));

      expect(output).toContain('Rolled back');
      expect(status).toBe(0);

      const state = await stateAfterRollback();

      expect(state.targetExists).toBe(false);
      expect(state.bookkeepingRows).toBe(0);
      // The delete was already visible from inside the down migration, so it
      // was in the same batch and — for the wrapped file, where the old script
      // could not manage it — the same transaction. That both halves merely
      // succeeded would not have told us that.
      expect(state.rowsVisibleToTheDownMigration).toBe(0);
    });

    it('leaves neither half applied when a statement fails part-way through', async () => {
      const { status, output } = runRollback(writeDown(failing(down)));

      expect(status).not.toBe(0);
      expect(output).toContain('division by zero');

      const state = await stateAfterRollback();

      expect(state.targetExists).toBe(true);
      expect(state.bookkeepingRows).toBe(1);
      expect(state.rowsVisibleToTheDownMigration).toBeNull();
    });
  });

  it('refuses a down.sql whose transaction it cannot extend, and changes nothing', async () => {
    const trailing = `${WRAPPED_DOWN}\nCREATE TABLE "tar346_after_commit" (id INT);\n`;

    const { status, output } = runRollback(writeDown(trailing));

    expect(status).not.toBe(0);
    expect(output).toContain('Refusing to roll back');

    const state = await stateAfterRollback();

    expect(state.targetExists).toBe(true);
    expect(state.bookkeepingRows).toBe(1);
  });
});
