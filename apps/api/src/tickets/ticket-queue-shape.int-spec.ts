import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';

/**
 * 0006 §6, asserted rather than assumed.
 *
 * The ticket queue is `status IN ('open','pending')` ordered
 * `priority DESC, created_at DESC, id DESC`, and the index `tickets` already
 * carried — `(tenant_id, status, priority, created_at DESC)` — cannot serve it.
 * Without `tickets_active_queue_idx` every page is a Bitmap Heap Scan plus a
 * top-N Sort over the tenant's **whole active set**, so the cost scales with the
 * backlog rather than with the page: invisible at hundreds of tickets, the
 * queue's dominant cost by the low thousands.
 *
 * This spec asserts the **property**, not a number, so it is a regression test
 * and not a benchmark:
 *
 *   * the queue page is served by `tickets_active_queue_idx`;
 *   * it carries no Sort node, so nothing is ordered in memory;
 *   * it filters nothing out, so the predicate is entirely in the index.
 *
 * It is also what catches the index going missing. Prisma's schema language has
 * no partial-index syntax and its describer skips predicated indexes, so nothing
 * in `schema.prisma` will ever regenerate it and `migrate dev` will never
 * complain that it is gone — the same trap `ticket-active-uniqueness.int-spec.ts`
 * exists for.
 *
 * ⚠️ Writes ~4 000 tickets under one fixture tenant and deletes them afterwards.
 * Seeding and `ANALYZE` run as the migration owner (`DATABASE_URL`) because
 * neither the app nor the system role owns the table; the **measurement** runs
 * as `whatsappcrm_app` under the tenant GUC, so the plan includes the RLS
 * predicate a real request pays for.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`.
 */

const TENANT = '25999999-9999-7999-8999-999999999901';

/**
 * Big enough that a top-N sort over the active set is visibly the wrong plan,
 * and small enough to seed in one statement. The failure this guards is a cost
 * that grows with the backlog; 4 000 is past the point where the planner stops
 * preferring a sequential scan whatever the indexes say.
 */
const ACTIVE_TICKETS = 4_000;
const PAGE = 25;

/** Verbatim the shape `TicketQueryService.list` emits for a supervisor's first page. */
const QUEUE_PAGE = `
  SELECT "id", "number", "status", "priority", "created_at"
  FROM "public"."tickets"
  WHERE "status" IN ('open', 'pending')
  ORDER BY "priority" DESC, "created_at" DESC, "id" DESC
  LIMIT ${PAGE}
`;

/** The row a first page ends on — what the next page's cursor is built from. */
interface CursorRow {
  priority: string;
  created_at: Date;
  id: string;
}

/**
 * The **second** page, in the enumerated-priority shape `cursorClauses` emits.
 *
 * Prisma's enum filters have no `lt`, so the leading column's bound cannot be
 * written the way `timestamp-keyset.ts` writes a timestamp's — the priorities
 * below the cursor's band are listed instead. `timestamp-keyset.ts` argues
 * against exactly this plain-OR form, on the grounds that a planner cannot fold
 * a nested `OR` into one index start condition, so accepting it here is a
 * deliberate exception and this is the measurement that makes it one.
 *
 * The values are fixture-controlled and interpolated as literals rather than
 * bound, so `EXPLAIN` reports the plan for *these* values instead of a generic
 * one.
 */
function resumedPage(cursor: CursorRow, below: readonly string[]): string {
  const bands = below.map((priority) => `'${priority}'`).join(', ');
  const at = cursor.created_at.toISOString();

  return `
    SELECT "id", "number", "status", "priority", "created_at"
    FROM "public"."tickets"
    WHERE "status" IN ('open', 'pending')
      AND (
        "priority" IN (${bands})
        OR ("priority" = '${cursor.priority}' AND "created_at" < '${at}')
        OR ("priority" = '${cursor.priority}' AND "created_at" = '${at}' AND "id" < '${cursor.id}')
      )
    ORDER BY "priority" DESC, "created_at" DESC, "id" DESC
    LIMIT ${PAGE}
  `;
}

/** Everything declared before `priority` in `ticket_priority` — its `prioritiesBelow`. */
function prioritiesBelow(priority: string): string[] {
  const declared = ['low', 'normal', 'high', 'urgent'];

  return declared.slice(0, declared.indexOf(priority));
}

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

interface Measurement {
  rowsFiltered: number;
  nodes: string[];
}

describe('the ticket queue query shape', () => {
  const tenantContext = new TenantContextService();

  let ownerPrisma: PrismaClient;
  let appBase: PrismaClient;
  let appPrisma: TenantPrisma;

  async function explain(sql: string): Promise<Measurement> {
    // Awaited *inside* the scope: the extension reads the tenant when the
    // promise is subscribed to, not when it is created, so returning an
    // un-awaited PrismaPromise would run it after the scope has closed.
    const rows = await tenantContext.run(
      { requestId: 'tar284-explain', tenantId: TENANT, userId: null, principal: null },
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
      rowsFiltered: total(plan, (node) => node['Rows Removed by Filter'] ?? 0),
      nodes: describeNodes(plan),
    };
  }

  function total(node: PlanNode, of: (node: PlanNode) => number): number {
    return (node.Plans ?? []).reduce((sum, child) => sum + total(child, of), of(node));
  }

  function describeNodes(node: PlanNode): string[] {
    const name = node['Index Name'];

    return [
      name === undefined ? node['Node Type'] : `${node['Node Type']} using ${name}`,
      ...(node.Plans ?? []).flatMap(describeNodes),
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

    // One tenant and a wide active backlog. Raw SQL through the owner: 4 000
    // rows via `generate_series` is one statement, and this fixture is about
    // volume rather than about exercising the ORM.
    //
    // One contact per ticket, because `tickets_one_active_per_contact` allows
    // no more — which is also what a real tenant's active queue looks like.
    // Priorities and ages are spread so the sort has work to do: a fixture where
    // every row shares a priority would let a plan look good by accident.
    await ownerPrisma.$executeRawUnsafe(`
      INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
        VALUES ('${TENANT}', 'tar284-explain', 'TAR-284 explain fixture', 'active', now(), now());

      INSERT INTO contacts (id, tenant_id, phone_e164, created_at, updated_at)
        SELECT gen_random_uuid(), '${TENANT}', '+2' || lpad(n::text, 12, '0'), now(), now()
        FROM generate_series(1, ${ACTIVE_TICKETS}) AS n;

      INSERT INTO tickets (id, tenant_id, number, status, priority, contact_id, created_at, updated_at)
        SELECT
          gen_random_uuid(),
          '${TENANT}',
          row_number() OVER (ORDER BY c.id),
          (ARRAY['open','pending']::ticket_status[])[1 + (row_number() OVER (ORDER BY c.id)) % 2],
          (ARRAY['low','normal','high','urgent']::ticket_priority[])[1 + (row_number() OVER (ORDER BY c.id)) % 4],
          c.id,
          now() - ((row_number() OVER (ORDER BY c.id)) || ' minutes')::interval,
          now()
        FROM contacts c
        WHERE c.tenant_id = '${TENANT}';

      ANALYZE tickets;
    `);
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([ownerPrisma.$disconnect(), appBase.$disconnect()]);
  });

  it('reads the queue page straight off tickets_active_queue_idx', async () => {
    const measured = await explain(QUEUE_PAGE);

    // The plan itself, so a failure here reads as "it stopped using the index"
    // rather than as a bare boolean — the same thing
    // `visibility-query-shape.int-spec.ts` prints for the inbox.
    console.info(`queue page: ${measured.nodes.join(' / ')}`);

    expect(measured.nodes.some((node) => node.includes('tickets_active_queue_idx'))).toBe(true);
  });

  it('carries no Sort node over the tenant’s active set', async () => {
    // The regression this file exists for. A Sort here means the index stopped
    // serving the order — dropped, or the query's `ORDER BY` drifted from it —
    // and the page silently starts costing what the whole backlog costs.
    const measured = await explain(QUEUE_PAGE);

    expect(measured.nodes.filter((node) => node.startsWith('Sort'))).toEqual([]);
  });

  it('filters nothing out of the rows it reads', async () => {
    // The `status` predicate lives in the index's own `WHERE`, so a resolved
    // ticket is never read and then discarded.
    const measured = await explain(QUEUE_PAGE);

    expect(measured.rowsFiltered).toBe(0);
  });

  it('serves a cursor-resumed page off the same index, sort and all', async () => {
    // The claim `ticket-query.service.ts` makes about the enumerated-priority
    // keyset, measured rather than asserted from the first page — which does not
    // exercise the OR predicate at all. This is the shape `timestamp-keyset.ts`
    // argues against, so if the planner ever answers it with a Sort over the
    // tenant's active set, the exception stops being justified and the answer is
    // a raw-SQL page for this one list.
    const [cursor] = await tenantContext.run(
      { requestId: 'tar284-cursor', tenantId: TENANT, userId: null, principal: null },
      async () => await appPrisma.$queryRawUnsafe<CursorRow[]>(`${QUEUE_PAGE} OFFSET ${PAGE - 1}`),
    );

    if (cursor === undefined) {
      throw new Error('the fixture produced no first page to resume from');
    }

    const measured = await explain(resumedPage(cursor, prioritiesBelow(cursor.priority)));

    console.info(`resumed page: ${measured.nodes.join(' / ')}`);

    expect(measured.nodes.filter((node) => node.startsWith('Sort'))).toEqual([]);
    expect(measured.nodes.some((node) => node.includes('tickets_active_queue_idx'))).toBe(true);
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
