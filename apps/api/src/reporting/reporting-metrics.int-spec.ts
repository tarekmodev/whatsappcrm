import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { ReportRangeResolver } from './report-range.resolver';
import { ReportingQueryService } from './reporting-query.service';

/**
 * The reporting dashboard against a real PostgreSQL (TAR-428, ADR 0010).
 *
 * Four things can only be proved here, and each is silent when it breaks:
 *
 *   1. **Isolation.** The aggregates are hand-written SQL with no `tenant_id`
 *      filter in them, because RLS supplies it. That is the one place in this
 *      codebase raw SQL is trusted to the policy alone, so tenant B's dashboard
 *      counting tenant A's tickets is the failure this file exists for.
 *   2. **The plans.** `tickets_tenant_id_first_response_at_idx` and its two
 *      siblings either serve their range or the query reads the tenant's whole
 *      history and filters. Both answer correctly; only one scales.
 *   3. **Tenant-local day boundaries.** A ticket at 23:30 local on the last day
 *      of the range is inside it and one at 00:30 the next day is not — which is
 *      a statement about `AT TIME ZONE`, not about TypeScript.
 *   4. **Reproducibility.** Re-running a closed range after new tickets arrive
 *      outside it returns identical numbers (0010 decision 2).
 *
 * ⚠️ Writes two fixture tenants and deletes them afterwards. Seeding and
 * `ANALYZE` run as the migration owner (`DATABASE_URL`) because neither the app
 * nor the system role owns the table; the **measurement** runs as
 * `whatsappcrm_app` under the tenant GUC, so every plan includes the RLS
 * predicate a real request pays for.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`.
 */

const TENANT_A = '25aaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaa01';
const TENANT_B = '25bbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbb01';
const AGENT_A = '25aaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaad1';
const AGENT_A2 = '25aaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaad2';
const AGENT_B = '25bbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbd1';

/** Riyadh is +03:00 year round — no DST, so a boundary case is arithmetic rather than a coin flip. */
const ZONE = 'Asia/Riyadh';

/**
 * Enough tickets that a sequential scan is visibly the wrong plan, and few
 * enough to seed in one statement. The failure being guarded is a cost that
 * grows with the tenant's whole history rather than with the chosen range.
 */
const BULK_TICKETS = 4_000;

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function principalFor(
  tenantId: string,
  userId: string,
  role: 'agent' | 'supervisor',
): SessionPrincipal {
  return {
    tenantId,
    userId,
    email: `${userId}@example.test`,
    displayName: 'Fixture User',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: '25aaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaae1',
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

describe('the reporting dashboard against a real database', () => {
  const tenantContext = new TenantContextService();

  let ownerPrisma: PrismaClient;
  let appBase: PrismaClient;
  let appPrisma: TenantPrisma;
  let reports: ReportingQueryService;

  function asPrincipal<T>(principal: SessionPrincipal, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      {
        requestId: 'tar428-int',
        tenantId: principal.tenantId,
        userId: principal.userId,
        principal,
      },
      work,
    );
  }

  async function removeFixtures(): Promise<void> {
    await ownerPrisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id IN ('${TENANT_A}', '${TENANT_B}')`,
    );
  }

  /** The plan's node names, so a failure reads as "it stopped using the index". */
  function describeNodes(node: PlanNode): string[] {
    const name = node['Index Name'];

    return [
      name === undefined ? node['Node Type'] : `${node['Node Type']} using ${name}`,
      ...(node.Plans ?? []).flatMap(describeNodes),
    ];
  }

  async function explain(principal: SessionPrincipal, sql: string): Promise<string[]> {
    // Awaited *inside* the scope: the extension reads the tenant when the promise
    // is subscribed to, not when it is created.
    const rows = await asPrincipal(
      principal,
      async () =>
        await appPrisma.$queryRawUnsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
        ),
    );

    const plan = rows[0]?.['QUERY PLAN']?.[0]?.Plan;

    if (plan === undefined) {
      throw new Error('EXPLAIN returned no plan');
    }

    return describeNodes(plan);
  }

  beforeAll(async () => {
    ownerPrisma = createPrismaClient('system', requireEnv('DATABASE_URL'));
    appBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    appPrisma = withTenantScope(appBase, tenantContext);
    reports = new ReportingQueryService(appPrisma, new ReportRangeResolver(), tenantContext);

    await removeFixtures();

    // Two tenants with deliberately different numbers, so "A sees B's rows"
    // fails on a value rather than only on a count.
    //
    // Tenant A: three tickets inside 1–3 August Riyadh time, each responded to
    // and resolved, attributed to two different agents. Plus the two boundary
    // tickets — 23:30 local on the 3rd (inside) and 00:30 local on the 4th
    // (outside) — and one closed without ever being resolved.
    await ownerPrisma.$executeRawUnsafe(`
      INSERT INTO tenants (id, slug, name, status, created_at, updated_at) VALUES
        ('${TENANT_A}', 'tar428-a', 'TAR-428 tenant A', 'active', now(), now()),
        ('${TENANT_B}', 'tar428-b', 'TAR-428 tenant B', 'active', now(), now());

      INSERT INTO tenant_settings (id, tenant_id, timezone, locale, created_at, updated_at) VALUES
        (gen_random_uuid(), '${TENANT_A}', '${ZONE}', 'en', now(), now()),
        (gen_random_uuid(), '${TENANT_B}', 'UTC', 'en', now(), now());

      INSERT INTO users (id, tenant_id, email, name, role, status, created_at, updated_at) VALUES
        ('${AGENT_A}',  '${TENANT_A}', 'a1@example.test', 'Ada',  'agent',      'active', now(), now()),
        ('${AGENT_A2}', '${TENANT_A}', 'a2@example.test', 'Omar', 'supervisor', 'active', now(), now()),
        ('${AGENT_B}',  '${TENANT_B}', 'b1@example.test', 'Bea',  'agent',      'active', now(), now());

      -- Tenant A. Times are UTC; Riyadh is +03:00, so 2026-08-01T06:00Z is
      -- 09:00 local on the 1st.
      INSERT INTO tickets
        (id, tenant_id, number, status, priority, assigned_user_id,
         created_at, first_response_at, first_response_user_id,
         resolved_at, resolved_by_user_id, closed_at, updated_at)
      VALUES
        -- created 09:00, answered after 300 s, resolved after 2 h. Ada.
        (gen_random_uuid(), '${TENANT_A}', 1, 'resolved', 'normal', '${AGENT_A}',
         '2026-08-01T06:00:00Z', '2026-08-01T06:05:00Z', '${AGENT_A}',
         '2026-08-01T08:00:00Z', '${AGENT_A}', NULL, now()),
        -- created 09:00 on the 2nd, answered after 900 s, resolved after 4 h. Omar.
        (gen_random_uuid(), '${TENANT_A}', 2, 'resolved', 'normal', '${AGENT_A2}',
         '2026-08-02T06:00:00Z', '2026-08-02T06:15:00Z', '${AGENT_A2}',
         '2026-08-02T10:00:00Z', '${AGENT_A2}', NULL, now()),
        -- 23:30 local on the 3rd = 20:30Z. Inside the range. Answered, never resolved.
        (gen_random_uuid(), '${TENANT_A}', 3, 'open', 'normal', '${AGENT_A}',
         '2026-08-03T20:30:00Z', '2026-08-03T20:40:00Z', '${AGENT_A}',
         NULL, NULL, NULL, now()),
        -- 00:30 local on the 4th = 21:30Z on the 3rd. Outside the range.
        (gen_random_uuid(), '${TENANT_A}', 4, 'open', 'normal', '${AGENT_A}',
         '2026-08-03T21:30:00Z', '2026-08-03T21:40:00Z', '${AGENT_A}',
         NULL, NULL, NULL, now()),
        -- Closed on the 2nd having never been resolved: the "closed unworked" signal.
        (gen_random_uuid(), '${TENANT_A}', 5, 'closed', 'low', NULL,
         '2026-08-02T07:00:00Z', NULL, NULL,
         NULL, NULL, '2026-08-02T09:00:00Z', now()),
        -- Responded to but with nobody recorded: the unattributed row.
        (gen_random_uuid(), '${TENANT_A}', 6, 'open', 'normal', NULL,
         '2026-08-01T07:00:00Z', '2026-08-01T07:30:00Z', NULL,
         NULL, NULL, NULL, now());

      -- Tenant B, inside the same range and with different numbers.
      INSERT INTO tickets
        (id, tenant_id, number, status, priority, assigned_user_id,
         created_at, first_response_at, first_response_user_id,
         resolved_at, resolved_by_user_id, closed_at, updated_at)
      VALUES
        (gen_random_uuid(), '${TENANT_B}', 1, 'resolved', 'normal', '${AGENT_B}',
         '2026-08-01T06:00:00Z', '2026-08-01T07:00:00Z', '${AGENT_B}',
         '2026-08-01T12:00:00Z', '${AGENT_B}', NULL, now()),
        (gen_random_uuid(), '${TENANT_B}', 2, 'resolved', 'normal', '${AGENT_B}',
         '2026-08-02T06:00:00Z', '2026-08-02T07:00:00Z', '${AGENT_B}',
         '2026-08-02T12:00:00Z', '${AGENT_B}', NULL, now());

      ANALYZE tickets;
    `);
  });

  afterAll(async () => {
    await removeFixtures();
    await Promise.all([ownerPrisma.$disconnect(), appBase.$disconnect()]);
  });

  const RANGE = { from: '2026-08-01', to: '2026-08-03', scope: 'all' as const } as const;

  describe('tenant isolation', () => {
    it('counts only the caller’s tenant, and the two disagree', async () => {
      // The assertion this whole file is for. The aggregates carry no
      // `tenant_id` predicate — RLS supplies it — so a policy that stopped
      // applying would show up here as A's numbers containing B's.
      const a = await asPrincipal(principalFor(TENANT_A, AGENT_A2, 'supervisor'), () =>
        reports.dashboard({ ...RANGE, assignedTeamId: undefined }),
      );
      const b = await asPrincipal(principalFor(TENANT_B, AGENT_B, 'agent'), () =>
        reports.dashboard({ ...RANGE, assignedTeamId: undefined }),
      );

      expect(a.summary.volume.created).toBe(5);
      expect(b.summary.volume.created).toBe(2);
    });

    it('never names another tenant’s agent in the breakdown', async () => {
      const a = await asPrincipal(principalFor(TENANT_A, AGENT_A2, 'supervisor'), () =>
        reports.dashboard({ ...RANGE, assignedTeamId: undefined }),
      );

      expect(a.agents.map((row) => row.userId)).not.toContain(AGENT_B);
      expect(a.agents.map((row) => row.name)).not.toContain('Bea');
    });
  });

  describe('the range is tenant-local', () => {
    it('includes 23:30 on the last day and excludes 00:30 the next', async () => {
      // Ticket 3 is 23:30 local on the 3rd; ticket 4 is 00:30 local on the 4th.
      // Both are on 2026-08-03 in UTC, so a range resolved in UTC counts both
      // and this is the only place that difference is visible.
      const report = await asPrincipal(principalFor(TENANT_A, AGENT_A2, 'supervisor'), () =>
        reports.dashboard({ ...RANGE, assignedTeamId: undefined }),
      );

      expect(report.range.timezone).toBe(ZONE);
      expect(report.range.startsAt).toBe('2026-07-31T21:00:00.000Z');
      expect(report.range.endsAt).toBe('2026-08-03T21:00:00.000Z');
      // Five created, not six: ticket 4 is the next day for this tenant.
      expect(report.summary.volume.created).toBe(5);
    });

    it('buckets the series into tenant-local days, every day present', async () => {
      const report = await asPrincipal(principalFor(TENANT_A, AGENT_A2, 'supervisor'), () =>
        reports.dashboard({ ...RANGE, assignedTeamId: undefined }),
      );

      expect(report.series.map((point) => point.date)).toEqual([
        '2026-08-01',
        '2026-08-02',
        '2026-08-03',
      ]);
      expect(report.series.map((point) => point.created)).toEqual([2, 2, 1]);
    });
  });

  describe('the metrics', () => {
    it('anchors each metric on its own column', async () => {
      const report = await asPrincipal(principalFor(TENANT_A, AGENT_A2, 'supervisor'), () =>
        reports.dashboard({ ...RANGE, assignedTeamId: undefined }),
      );

      expect(report.summary.volume).toEqual({
        created: 5,
        resolved: 2,
        closedWithoutResolution: 1,
      });
      // 300 s, 900 s, 600 s (ticket 3) and 1 800 s (ticket 6, unattributed).
      // `percentile_cont` **interpolates** rather than picking a member, so an
      // even-sized set has no element as its median: sorted [300, 600, 900,
      // 1800], the answer is the midpoint of the middle pair, 750.
      expect(report.summary.firstResponse.count).toBe(4);
      expect(report.summary.firstResponse.medianSeconds).toBe(750);
      // Two resolutions, 2 h and 4 h; interpolated, that is 3 h.
      expect(report.summary.resolution.count).toBe(2);
      expect(report.summary.resolution.medianSeconds).toBe(10_800);
      // The mean agrees here only because there are two values. It is asserted
      // beside the median so that a future fixture change that makes them
      // diverge has to say which one moved.
      expect(report.summary.resolution.averageSeconds).toBe(10_800);
    });

    it('attributes work to who did it, and renders the rest as unattributed', async () => {
      const report = await asPrincipal(principalFor(TENANT_A, AGENT_A2, 'supervisor'), () =>
        reports.dashboard({ ...RANGE, assignedTeamId: undefined }),
      );

      const ada = report.agents.find((row) => row.userId === AGENT_A);
      const unattributed = report.agents.find((row) => row.userId === null);

      expect(ada?.firstResponse.count).toBe(2);
      expect(ada?.resolution.count).toBe(1);
      // Ticket 6 was answered with no recorded responder. Rendered, not dropped.
      expect(unattributed?.firstResponse.count).toBe(1);
      // The breakdown adds up to the summary.
      const counted = report.agents.reduce((sum, row) => sum + row.firstResponse.count, 0);

      expect(counted).toBe(report.summary.firstResponse.count);
    });

    it('gives an agent one row and the same aggregate set the queue would list', async () => {
      // Decision 6, plus the scope narrowing, against a real RLS-scoped read:
      // Ada holds tickets 1, 3 and 4, so her range covers 1 and 3.
      const report = await asPrincipal(principalFor(TENANT_A, AGENT_A, 'agent'), () =>
        reports.dashboard({ ...RANGE, assignedTeamId: undefined }),
      );

      expect(report.scope).toBe('assigned');
      expect(report.agents.map((row) => row.userId)).toEqual([AGENT_A]);
      expect(report.summary.volume.created).toBe(2);
    });

    it('is reproducible when work arrives outside the range', async () => {
      // 0010 decision 2's whole reason for event anchoring. A supervisor who
      // exported on Monday and re-exports on Friday must get the same numbers.
      const supervisor = principalFor(TENANT_A, AGENT_A2, 'supervisor');
      const before = await asPrincipal(supervisor, () =>
        reports.dashboard({ ...RANGE, assignedTeamId: undefined }),
      );

      await ownerPrisma.$executeRawUnsafe(`
        INSERT INTO tickets
          (id, tenant_id, number, status, priority, created_at,
           first_response_at, first_response_user_id, resolved_at, resolved_by_user_id, updated_at)
        VALUES
          (gen_random_uuid(), '${TENANT_A}', 7, 'resolved', 'normal', '2026-09-01T06:00:00Z',
           '2026-09-01T06:10:00Z', '${AGENT_A}', '2026-09-01T09:00:00Z', '${AGENT_A}', now());
      `);

      const after = await asPrincipal(supervisor, () =>
        reports.dashboard({ ...RANGE, assignedTeamId: undefined }),
      );

      expect(after.summary).toEqual(before.summary);
    });

    it('returns null durations rather than zeros for an empty range', async () => {
      // 2025, deliberately: no fixture in this file writes a ticket there, so
      // this stays empty however the seeds below it grow. January 2026 would
      // read as empty today and silently stop being empty the moment the
      // query-plan fixture lands.
      const report = await asPrincipal(principalFor(TENANT_A, AGENT_A2, 'supervisor'), () =>
        reports.dashboard({ from: '2025-01-01', to: '2025-01-03', scope: 'all' }),
      );

      expect(report.summary.firstResponse).toEqual({
        count: 0,
        averageSeconds: null,
        medianSeconds: null,
        p90Seconds: null,
      });
      // The series still carries every day, so a chart renders a flat line
      // rather than nothing.
      expect(report.series).toHaveLength(3);
    });
  });

  describe('the query plans (ADR 0010 risk 3)', () => {
    /**
     * A tenant with a real backlog, so the planner has a reason to prefer an
     * index. Seeded here rather than in the outer `beforeAll` because every
     * assertion above is about values and would only be slower for it.
     *
     * All four anchor columns are written on every row, `closed_at` included.
     * Leaving it NULL would put 4 000 NULLs in `tickets_tenant_id_closed_at_idx`
     * and give the planner no reason to choose it, so the closed-unworked
     * assertion below would be measuring an empty index rather than the access
     * path a real tenant pays for. Every row is a distinct minute in January
     * 2026, which is outside the August range the value assertions above use —
     * so this fixture cannot move any of their numbers.
     */
    beforeAll(async () => {
      await ownerPrisma.$executeRawUnsafe(`
        INSERT INTO tickets
          (id, tenant_id, number, status, priority, created_at,
           first_response_at, resolved_at, closed_at, updated_at)
        SELECT
          gen_random_uuid(), '${TENANT_A}', 1000 + n, 'closed', 'normal',
          '2026-01-01T00:00:00Z'::timestamptz + (n || ' minutes')::interval,
          '2026-01-01T00:10:00Z'::timestamptz + (n || ' minutes')::interval,
          '2026-01-01T02:00:00Z'::timestamptz + (n || ' minutes')::interval,
          '2026-01-01T03:00:00Z'::timestamptz + (n || ' minutes')::interval,
          now()
        FROM generate_series(1, ${BULK_TICKETS}) AS n;

        ANALYZE tickets;
      `);

      // Separate call, and **not** part of the statement above: Prisma sends a
      // multi-statement raw string as one implicit transaction, and Postgres
      // refuses `VACUUM` inside a transaction block (SQLSTATE 25001) — which
      // fails the whole seed rather than just the vacuum.
      //
      // Best-effort on purpose. It refreshes the visibility map so an
      // index-only scan is available, which is the caveat 20260815140000's
      // header records for a freshly bulk-loaded table. The assertions below do
      // not depend on it: they require the right index and no sequential scan,
      // and an `Index Scan` and an `Index Only Scan` both satisfy that. The
      // `ANALYZE` above is what actually decides index-versus-seq, and it runs
      // either way.
      await ownerPrisma
        .$executeRawUnsafe('VACUUM (ANALYZE) tickets')
        .catch((error: unknown) =>
          console.info(
            `VACUUM skipped; plans are measured without a visibility map: ${String(error)}`,
          ),
        );
    });

    const supervisor = () => principalFor(TENANT_A, AGENT_A2, 'supervisor');

    it('serves the response-time range off its own index', async () => {
      // `tickets_reporting_metrics_idx` cannot: `first_response_at` sits fifth
      // in it, unreachable as a range start. Without this index the aggregate
      // reads the tenant's whole history whatever range was asked for.
      const nodes = await explain(
        supervisor(),
        `SELECT count(*) FROM "public"."tickets"
          WHERE "first_response_at" >= '2026-08-01T00:00:00Z'
            AND "first_response_at" <  '2026-08-04T00:00:00Z'`,
      );

      console.info(`first-response range: ${nodes.join(' / ')}`);

      expect(nodes.some((node) => node.includes('tickets_tenant_id_first_response_at_idx'))).toBe(
        true,
      );
      expect(nodes.some((node) => node.includes('Seq Scan'))).toBe(false);
    });

    it('serves the resolution-time range off its own index', async () => {
      const nodes = await explain(
        supervisor(),
        `SELECT count(*) FROM "public"."tickets"
          WHERE "resolved_at" >= '2026-08-01T00:00:00Z'
            AND "resolved_at" <  '2026-08-04T00:00:00Z'`,
      );

      console.info(`resolution range: ${nodes.join(' / ')}`);

      expect(nodes.some((node) => node.includes('tickets_tenant_id_resolved_at_idx'))).toBe(true);
      expect(nodes.some((node) => node.includes('Seq Scan'))).toBe(false);
    });

    it('serves the closed-unworked count off its own index', async () => {
      const nodes = await explain(
        supervisor(),
        `SELECT count(*) FROM "public"."tickets"
          WHERE "closed_at" >= '2026-08-01T00:00:00Z'
            AND "closed_at" <  '2026-08-04T00:00:00Z'
            AND "resolved_at" IS NULL`,
      );

      console.info(`closed-unworked range: ${nodes.join(' / ')}`);

      expect(nodes.some((node) => node.includes('tickets_tenant_id_closed_at_idx'))).toBe(true);
    });

    it('serves the created-volume range off TAR-427’s covering index', async () => {
      // The one anchor this story adds no index for, because 20260815140000
      // already leads with `(tenant_id, created_at)`. Asserted so that dropping
      // it fails here rather than in production.
      const nodes = await explain(
        supervisor(),
        `SELECT count(*) FROM "public"."tickets"
          WHERE "created_at" >= '2026-08-01T00:00:00Z'
            AND "created_at" <  '2026-08-04T00:00:00Z'`,
      );

      console.info(`created range: ${nodes.join(' / ')}`);

      expect(nodes.some((node) => node.includes('tickets_reporting_metrics_idx'))).toBe(true);
      expect(nodes.some((node) => node.includes('Seq Scan'))).toBe(false);
    });

    it('groups the per-agent breakdown without reading the whole table', async () => {
      const nodes = await explain(
        supervisor(),
        `SELECT "first_response_user_id", grouping("first_response_user_id"), count(*)
           FROM "public"."tickets"
          WHERE "first_response_at" >= '2026-08-01T00:00:00Z'
            AND "first_response_at" <  '2026-08-04T00:00:00Z'
          GROUP BY GROUPING SETS (("first_response_user_id"), ())`,
      );

      console.info(`per-agent breakdown: ${nodes.join(' / ')}`);

      expect(nodes.some((node) => node.includes('Seq Scan'))).toBe(false);
    });
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
