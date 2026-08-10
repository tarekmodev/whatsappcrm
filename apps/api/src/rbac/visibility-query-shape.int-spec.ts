import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';

/**
 * TAR-79, open question 1 — measured rather than assumed.
 *
 * The visibility predicate is "mine OR my teams'". TAR-80 landed two indexes to
 * serve it, each carrying the keyset sort key
 * (`conversations_tenant_assigned_user_inbox_idx`, `…_team_inbox_idx`), and
 * warned that the query *shape* is the other half of the fix: written as one
 * `OR` beside an `ORDER BY … LIMIT`, the planner cannot use either index for
 * the ordering and falls back to the tenant-wide index plus a filter — so an
 * agent's inbox costs what the whole tenant holds, and gets slower as their
 * colleagues work.
 *
 * This spec runs both shapes against a real table with a realistic skew. **The
 * measurement does not support the warning**, which is why `visibilityFilter()`
 * returns one composed `OR` and not a list of branches: with both scope indexes
 * present the planner answers the `OR` with a `BitmapOr` across them, filters
 * nothing, and reads fewer buffers than the `UNION ALL` does. The numbers are in
 * `visibility.ts`; the assertions below are on the property rather than the
 * numbers, so this stays a regression test and not a benchmark.
 *
 * ⚠️ Writes ~20 000 rows under one fixture tenant and deletes them afterwards.
 * Seeding and `ANALYZE` run as the migration owner (`DATABASE_URL`) because
 * neither the app nor the system role owns the table; the **measurement** runs
 * as `whatsappcrm_app` under the tenant GUC, so the plan includes the RLS
 * predicate a real request pays for.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`.
 */

const TENANT = '81999999-9999-7999-8999-999999999901';
const AGENT = '81999999-9999-7999-8999-9999999999a1';
const TEAM = '81999999-9999-7999-8999-99999999a001';
const WABA = '81999999-9999-7999-8999-99999999c001';
const ACCOUNT = '81999999-9999-7999-8999-99999999d001';

/** Big enough that a sequential scan is never the cheapest plan. */
const CONVERSATIONS = 20_000;
/** What the principal holds — a quiet queue beside a busy one. */
const MINE = 400;
const MY_TEAMS = 400;
const PAGE = 25;

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

/** Buffers plus the node/index shape, which is what makes the number readable. */
interface Measurement {
  buffers: number;
  rowsFiltered: number;
  nodes: string[];
}

describe('the agent inbox query shape', () => {
  const tenantContext = new TenantContextService();

  let ownerPrisma: PrismaClient;
  let appBase: PrismaClient;
  let appPrisma: TenantPrisma;

  /** Shared buffers touched — the cost that scales — plus the plan that explains it. */
  async function explain(sql: string): Promise<Measurement> {
    // Awaited *inside* the scope: the extension reads the tenant when the
    // promise is subscribed to, not when it is created, so returning an
    // un-awaited PrismaPromise would run it after the scope has closed.
    const rows = await tenantContext.run(
      { requestId: 'tar81-explain', tenantId: TENANT, userId: null, principal: null },
      async () =>
        await appPrisma.$queryRawUnsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
        ),
    );

    const plan = rows[0]?.['QUERY PLAN']?.[0]?.Plan;

    if (plan === undefined) {
      throw new Error('EXPLAIN returned no plan');
    }

    return {
      buffers: total(
        plan,
        (node) => (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0),
      ),
      rowsFiltered: total(plan, (node) => node['Rows Removed by Filter'] ?? 0),
      nodes: describe(plan),
    };
  }

  function total(node: PlanNode, of: (node: PlanNode) => number): number {
    return (node.Plans ?? []).reduce((sum, child) => sum + total(child, of), of(node));
  }

  function describe(node: PlanNode): string[] {
    const name = node['Index Name'];

    return [
      name === undefined ? node['Node Type'] : `${node['Node Type']} using ${name}`,
      ...(node.Plans ?? []).flatMap(describe),
    ];
  }

  async function removeFixture(): Promise<void> {
    await ownerPrisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = '${TENANT}'`);
  }

  beforeAll(async () => {
    ownerPrisma = createPrismaClient('system', requireEnv('DATABASE_URL'));
    appBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    appPrisma = withTenantScope(appBase, tenantContext);

    await removeFixture();

    // One tenant, one agent, one team, one WhatsApp number, and a wide inbox.
    // Written as raw SQL through the owner: 20 000 rows via `generate_series`
    // is one statement, and this fixture is about volume, not about exercising
    // the ORM.
    await ownerPrisma.$executeRawUnsafe(`
      INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
        VALUES ('${TENANT}', 'tar81-explain', 'TAR-81 explain fixture', 'active', now(), now());
      INSERT INTO users (id, tenant_id, email, name, role, status, created_at, updated_at)
        VALUES ('${AGENT}', '${TENANT}', 'agent@tar81-explain.invalid', 'Explain Agent', 'agent', 'active', now(), now());
      INSERT INTO teams (id, tenant_id, name, created_at, updated_at)
        VALUES ('${TEAM}', '${TENANT}', 'Billing', now(), now());
      INSERT INTO whatsapp_business_accounts (id, tenant_id, waba_id, created_at, updated_at)
        VALUES ('${WABA}', '${TENANT}', 'tar81-explain-waba', now(), now());
      INSERT INTO whatsapp_accounts (id, tenant_id, whatsapp_business_account_id, phone_number_id, display_phone_number, created_at, updated_at)
        VALUES ('${ACCOUNT}', '${TENANT}', '${WABA}', 'tar81-explain-number', '+10000000000', now(), now());

      INSERT INTO contacts (id, tenant_id, phone_e164, created_at, updated_at)
        SELECT gen_random_uuid(), '${TENANT}', '+1' || lpad(n::text, 12, '0'), now(), now()
        FROM generate_series(1, ${CONVERSATIONS}) AS n;

      INSERT INTO conversations (
        id, tenant_id, whatsapp_account_id, contact_id, status,
        assigned_user_id, assigned_team_id, last_message_at, created_at, updated_at)
        SELECT
          gen_random_uuid(), '${TENANT}', '${ACCOUNT}', c.id, 'open',
          -- The principal holds the oldest slice, which is the realistic skew:
          -- a new hire, or a quiet queue beside a busy one.
          CASE WHEN c.rn <= ${MINE} THEN '${AGENT}'::uuid ELSE NULL END,
          CASE WHEN c.rn > ${MINE} AND c.rn <= ${MINE + MY_TEAMS} THEN '${TEAM}'::uuid ELSE NULL END,
          now() - (c.rn || ' minutes')::interval, now(), now()
        FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM contacts WHERE tenant_id = '${TENANT}') AS c;

      ANALYZE conversations;
    `);
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([ownerPrisma.$disconnect(), appBase.$disconnect()]);
  });

  const OR_FORM = `
    SELECT id, last_message_at
    FROM conversations
    WHERE status = 'open'
      AND (assigned_user_id = '${AGENT}'::uuid OR assigned_team_id = '${TEAM}'::uuid)
    ORDER BY last_message_at DESC, id DESC
    LIMIT ${PAGE}
  `;

  /**
   * The alternative TAR-79 proposed: one keyset page per scope member, each an
   * equality on its own column with the sort key next in the index, merged by
   * the caller.
   */
  const BRANCHED_FORM = `
    SELECT id, last_message_at FROM (
      (SELECT id, last_message_at
         FROM conversations
        WHERE assigned_user_id = '${AGENT}'::uuid AND status = 'open'
        ORDER BY last_message_at DESC, id DESC
        LIMIT ${PAGE})
      UNION ALL
      (SELECT id, last_message_at
         FROM conversations
        WHERE assigned_team_id = '${TEAM}'::uuid AND status = 'open'
        ORDER BY last_message_at DESC, id DESC
        LIMIT ${PAGE})
    ) AS branches
    ORDER BY last_message_at DESC, id DESC
    LIMIT ${PAGE}
  `;

  it('never falls back to the tenant-wide index, in either form', async () => {
    // This is the regression that actually matters, and the one TAR-80's index
    // work exists to prevent: a plan that scans
    // `conversations_tenant_id_status_last_message_at_id_idx` and demotes the
    // scope to a filter costs what the *tenant* holds, so a quiet agent's inbox
    // gets slower as their colleagues work.
    for (const [label, sql] of [
      ['OR', OR_FORM],
      ['branched', BRANCHED_FORM],
    ] as const) {
      const measured = await explain(sql);

      console.info(
        `${label} form: ${measured.buffers} shared buffers, ` +
          `${measured.rowsFiltered} rows filtered — ${measured.nodes.join(' / ')}`,
      );

      const scopeIndexes = measured.nodes.filter((node) =>
        /assigned_(user|team)_inbox_idx/.test(node),
      );

      expect({ label, usesScopeIndexes: scopeIndexes.length > 0 }).toEqual({
        label,
        usesScopeIndexes: true,
      });
    }
  });

  it('costs about the same either way at this size, so the OR form is not a trap', async () => {
    const [orForm, branched] = [await explain(OR_FORM), await explain(BRANCHED_FORM)];

    // ⚠️ **This is the answer to TAR-79's open question 1, and it is not the
    // answer the note predicted.** With both of TAR-80's scope indexes in
    // place, the planner answers the `OR` form with a `BitmapOr` across them
    // rather than with the tenant-wide index, so the work already scales with
    // the principal's set rather than the tenant's — the failure the note was
    // guarding against does not occur, and the `UNION ALL` form is not cheaper.
    //
    // Held as a ratio rather than a fixed number: what is being asserted is
    // that neither form is an order of magnitude worse, which is what would
    // make the choice matter. If this ever fails, one of them has stopped using
    // the scope indexes and the previous test will say which.
    const ratio =
      Math.max(orForm.buffers, branched.buffers) / Math.min(orForm.buffers, branched.buffers);

    expect(ratio).toBeLessThan(4);
  });

  it('returns the same page either way, so the shape is an optimisation only', async () => {
    const read = (sql: string): Promise<{ id: string }[]> =>
      tenantContext.run(
        { requestId: 'tar81-explain-rows', tenantId: TENANT, userId: null, principal: null },
        async () => await appPrisma.$queryRawUnsafe<{ id: string }[]>(sql),
      );

    const viaOr = await read(`
      SELECT id FROM conversations
      WHERE status = 'open'
        AND (assigned_user_id = '${AGENT}'::uuid OR assigned_team_id = '${TEAM}'::uuid)
      ORDER BY last_message_at DESC, id DESC LIMIT ${PAGE}
    `);

    const viaBranches = await read(`
      SELECT id FROM (
        (SELECT id, last_message_at FROM conversations
          WHERE assigned_user_id = '${AGENT}'::uuid AND status = 'open'
          ORDER BY last_message_at DESC, id DESC LIMIT ${PAGE})
        UNION ALL
        (SELECT id, last_message_at FROM conversations
          WHERE assigned_team_id = '${TEAM}'::uuid AND status = 'open'
          ORDER BY last_message_at DESC, id DESC LIMIT ${PAGE})
      ) AS branches
      ORDER BY last_message_at DESC, id DESC LIMIT ${PAGE}
    `);

    expect(viaBranches).toEqual(viaOr);
    expect(viaOr).toHaveLength(PAGE);
  });
});

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
