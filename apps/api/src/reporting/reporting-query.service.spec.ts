import {
  DashboardMetricsResponseSchema,
  permissionsForRole,
  type DashboardMetricsQuery,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { ReportRangeResolver } from './report-range.resolver';
import { ReportingQueryService } from './reporting-query.service';
import { REPORT_STATEMENT_TIMEOUT_MS } from './reporting.constants';
import { ReportTeamNotFoundError } from './reporting.errors';

/**
 * What the reporting reader decides on its own, and what only it can be asked
 * about: how the `GROUPING SETS` rows are taken apart, which agents a caller may
 * see broken out, what an empty range looks like, and that the response is the
 * shape the contract publishes.
 *
 * The database is stubbed here on purpose. That RLS really isolates and that the
 * range indexes really serve these predicates is
 * `reporting-metrics.int-spec.ts`'s job against a real PostgreSQL; what this
 * file proves is the *rules* — including the ones that are invisible in an
 * integration test because they concern rows the aggregate does not return, like
 * an agent who did nothing in the range.
 */

const TENANT = '25888888-8888-7888-8888-888888888801';
const RANA = '25888888-8888-7888-8888-8888888888d1';
const OMAR = '25888888-8888-7888-8888-8888888888d2';
/** Left the company; still has work inside the range. */
const DEPARTED = '25888888-8888-7888-8888-8888888888d3';
const TEAM = '25888888-8888-7888-8888-8888888888b1';

const QUERY: DashboardMetricsQuery = {
  from: '2026-08-01',
  to: '2026-08-03',
  scope: 'all',
  assignedTeamId: undefined,
};

const RANGE_ROW = {
  timezone: 'Asia/Riyadh',
  starts_at: new Date('2026-07-31T21:00:00.000Z'),
  ends_at: new Date('2026-08-03T21:00:00.000Z'),
  fell_back: false,
};

/** `grouping()` answers 1 for the row aggregated over everything, 0 otherwise. */
const TOTAL = 1;
const PER_AGENT = 0;

interface DurationRow {
  user_id: string | null;
  is_total: number;
  n: number;
  avg_seconds: number | null;
  p50_seconds: number | null;
  p90_seconds: number | null;
}

interface RosterRow {
  id: string;
  name: string;
  status: 'active' | 'invited' | 'suspended' | 'removed';
}

interface Fixture {
  readonly volume?: { created: number; resolved: number; closed_unworked: number };
  readonly firstResponse?: DurationRow[];
  readonly resolution?: DurationRow[];
  readonly series?: {
    day: string;
    created: number;
    resolved: number;
    first_response_median_seconds: number | null;
  }[];
  readonly roster?: RosterRow[];
  /** `null` makes the team lookup answer nothing, which is `not_found`. */
  readonly team?: { id: string } | null;
}

interface Harness {
  readonly reports: ReportingQueryService;
  /** Every statement the service sent, in order, flattened the way Prisma flattens one. */
  readonly statements: string[];
  /** The `where` of every roster read — one per request. */
  readonly rosterWhere: unknown[];
  readonly asPrincipal: <T>(
    principal: SessionPrincipal,
    work: (reports: ReportingQueryService) => Promise<T>,
  ) => Promise<T>;
}

function principal(role: 'agent' | 'supervisor', userId = RANA): SessionPrincipal {
  return {
    tenantId: TENANT,
    userId,
    email: 'someone@example.test',
    displayName: 'Someone',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [TEAM],
    sessionId: '25888888-8888-7888-8888-8888888888s1',
    expiresAt: '2026-08-16T09:00:00.000Z',
  };
}

/**
 * Dispatches on what each statement is asking for rather than on call order, so
 * a reordering inside the service does not silently feed the volume rows to the
 * series and pass.
 */
function harnessFor(fixture: Fixture = {}): Harness {
  const statements: string[] = [];
  const rosterWhere: unknown[] = [];
  const tenantContext = new TenantContextService();

  const tx = {
    $executeRawUnsafe: (sql: string) => {
      statements.push(sql);

      return Promise.resolve(0);
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const sql = new Prisma.Sql(strings, values).sql;

      statements.push(sql);

      if (sql.includes('tenant_settings')) {
        return Promise.resolve([RANGE_ROW]);
      }

      if (sql.includes('closed_unworked')) {
        return Promise.resolve([fixture.volume ?? { created: 0, resolved: 0, closed_unworked: 0 }]);
      }

      if (sql.includes('generate_series')) {
        return Promise.resolve(fixture.series ?? []);
      }

      if (sql.includes('first_response_user_id')) {
        return Promise.resolve(fixture.firstResponse ?? [emptyTotal()]);
      }

      if (sql.includes('resolved_by_user_id')) {
        return Promise.resolve(fixture.resolution ?? [emptyTotal()]);
      }

      throw new Error(`The harness does not know this statement: ${sql}`);
    },
    team: {
      // `??` would be wrong here: `team: null` is the fixture saying "the lookup
      // finds nothing", which is exactly the value it would fall through.
      findUnique: () => Promise.resolve(fixture.team === undefined ? { id: TEAM } : fixture.team),
    },
    user: {
      findMany: ({ where }: { where: unknown }) => {
        rosterWhere.push(where);

        return Promise.resolve(fixture.roster ?? []);
      },
    },
  };

  const prisma = {
    $tenantTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as TenantPrisma;

  return {
    reports: new ReportingQueryService(prisma, new ReportRangeResolver(), tenantContext),
    statements,
    rosterWhere,
    asPrincipal: (caller, work) =>
      tenantContext.run(
        { requestId: 'tar428-spec', tenantId: TENANT, userId: caller.userId, principal: caller },
        () => work(new ReportingQueryService(prisma, new ReportRangeResolver(), tenantContext)),
      ),
  };
}

/** The empty grouping set's row: it exists even over zero input rows. */
function emptyTotal(): DurationRow {
  return {
    user_id: null,
    is_total: TOTAL,
    n: 0,
    avg_seconds: null,
    p50_seconds: null,
    p90_seconds: null,
  };
}

function durations(user_id: string | null, n: number, seconds: number): DurationRow {
  return {
    user_id,
    is_total: PER_AGENT,
    n,
    avg_seconds: seconds,
    p50_seconds: seconds,
    p90_seconds: seconds,
  };
}

describe('the transaction it runs in', () => {
  it('caps its own statement time before anything else runs', async () => {
    // The pool-wide 30 s ceiling exists to stop a runaway statement holding a
    // connection; this is the reporting-specific bound, and it has to be set
    // before the first aggregate rather than after it.
    const harness = harnessFor();

    await harness.asPrincipal(principal('supervisor'), (reports) => reports.dashboard(QUERY));

    expect(harness.statements[0]).toBe(
      `SET LOCAL statement_timeout = ${REPORT_STATEMENT_TIMEOUT_MS}`,
    );
  });

  it('refuses a team filter naming a team this tenant does not have', async () => {
    // RLS makes "no such team" and "another tenant's team" the same answer, and
    // 0002's rule is that a 403 confirms an id exists — so this is `not_found`.
    // Without it the filter matches nothing and the caller gets a dashboard of
    // zeroes indistinguishable from a quiet week.
    const harness = harnessFor({ team: null });

    await expect(
      harness.asPrincipal(principal('supervisor'), (reports) =>
        reports.dashboard({ ...QUERY, assignedTeamId: TEAM }),
      ),
    ).rejects.toBeInstanceOf(ReportTeamNotFoundError);
  });

  it('runs no team lookup when no team was asked for', async () => {
    const harness = harnessFor({ team: null });

    await expect(
      harness.asPrincipal(principal('supervisor'), (reports) => reports.dashboard(QUERY)),
    ).resolves.toBeDefined();
  });
});

describe('taking the GROUPING SETS rows apart', () => {
  it('tells the total row from the unattributed row, which both carry a null user', async () => {
    // The one place this query can silently go wrong. `grouping()` is what
    // separates them; without it the tenant total would be rendered as an
    // agent's row called "unattributed" and counted twice.
    const harness = harnessFor({
      resolution: [
        {
          user_id: null,
          is_total: TOTAL,
          n: 10,
          avg_seconds: 600,
          p50_seconds: 540,
          p90_seconds: 900,
        },
        durations(RANA, 7, 480),
        durations(null, 3, 900),
      ],
      roster: [{ id: RANA, name: 'Rana', status: 'active' }],
    });

    const report = await harness.asPrincipal(principal('supervisor'), (reports) =>
      reports.dashboard(QUERY),
    );

    expect(report.summary.resolution).toEqual({
      count: 10,
      averageSeconds: 600,
      medianSeconds: 540,
      p90Seconds: 900,
    });
    expect(report.agents).toEqual([
      expect.objectContaining({ userId: RANA, ticketsResolved: 7 }),
      expect.objectContaining({ userId: null, name: null, ticketsResolved: 3 }),
    ]);
  });

  it('puts the unattributed row last, so the table still adds up to the summary', async () => {
    const harness = harnessFor({
      resolution: [
        { user_id: null, is_total: TOTAL, n: 4, avg_seconds: 60, p50_seconds: 60, p90_seconds: 60 },
        durations(null, 4, 60),
      ],
      roster: [{ id: RANA, name: 'Rana', status: 'active' }],
    });

    const report = await harness.asPrincipal(principal('supervisor'), (reports) =>
      reports.dashboard(QUERY),
    );

    expect(report.agents.at(-1)?.userId).toBeNull();
    // Rendered rather than hidden: dropping it leaves a breakdown that does not
    // reconcile with the total above it and no explanation of the difference.
    expect(report.agents.at(-1)?.resolution.count).toBe(4);
  });

  it('omits the unattributed row entirely when every ticket is attributed', async () => {
    const harness = harnessFor({
      resolution: [
        { user_id: null, is_total: TOTAL, n: 2, avg_seconds: 60, p50_seconds: 60, p90_seconds: 60 },
        durations(RANA, 2, 60),
      ],
      roster: [{ id: RANA, name: 'Rana', status: 'active' }],
    });

    const report = await harness.asPrincipal(principal('supervisor'), (reports) =>
      reports.dashboard(QUERY),
    );

    expect(report.agents.map((row) => row.userId)).toEqual([RANA]);
  });
});

describe('the per-agent breakdown', () => {
  it('zero-fills every active agent, including one with nothing in the range', async () => {
    // A supervisor comparing a team needs the zero rows: an agent who resolved
    // nothing is a fact about the range, and their absence reads as a loading
    // bug. The aggregate cannot supply them — no tickets means no group — which
    // is why the roster is its own read.
    const harness = harnessFor({
      resolution: [
        { user_id: null, is_total: TOTAL, n: 3, avg_seconds: 90, p50_seconds: 90, p90_seconds: 90 },
        durations(RANA, 3, 90),
      ],
      roster: [
        { id: OMAR, name: 'Omar', status: 'active' },
        { id: RANA, name: 'Rana', status: 'active' },
      ],
    });

    const report = await harness.asPrincipal(principal('supervisor'), (reports) =>
      reports.dashboard(QUERY),
    );

    expect(report.agents).toEqual([
      expect.objectContaining({
        userId: OMAR,
        isActive: true,
        ticketsResolved: 0,
        resolution: { count: 0, averageSeconds: null, medianSeconds: null, p90Seconds: null },
      }),
      expect.objectContaining({ userId: RANA, ticketsResolved: 3 }),
    ]);
  });

  it('keeps a departed agent who has work in the range, flagged inactive', async () => {
    // So a closed period's numbers do not change when somebody leaves.
    const harness = harnessFor({
      resolution: [
        { user_id: null, is_total: TOTAL, n: 5, avg_seconds: 90, p50_seconds: 90, p90_seconds: 90 },
        durations(DEPARTED, 5, 90),
      ],
      roster: [{ id: DEPARTED, name: 'Yusuf', status: 'removed' }],
    });

    const report = await harness.asPrincipal(principal('supervisor'), (reports) =>
      reports.dashboard(QUERY),
    );

    expect(report.agents).toEqual([
      expect.objectContaining({ userId: DEPARTED, isActive: false, ticketsResolved: 5 }),
    ]);
  });

  it('asks for the active roster plus anyone attributed, for a supervisor', async () => {
    const harness = harnessFor({
      resolution: [
        { user_id: null, is_total: TOTAL, n: 5, avg_seconds: 90, p50_seconds: 90, p90_seconds: 90 },
        durations(DEPARTED, 5, 90),
      ],
    });

    await harness.asPrincipal(principal('supervisor'), (reports) => reports.dashboard(QUERY));

    expect(harness.rosterWhere).toEqual([
      { OR: [{ status: 'active' }, { id: { in: [DEPARTED] } }] },
    ]);
  });

  it('gives an agent exactly their own row (ADR 0010 decision 6)', async () => {
    // Their visible set includes their team's tickets, so a per-agent table over
    // it would be a ranking of their colleagues — a disclosure no acceptance
    // criterion asks for on an agent's behalf. This narrows and can never
    // widen: the summary below still covers the same visible set.
    const harness = harnessFor({
      resolution: [
        { user_id: null, is_total: TOTAL, n: 9, avg_seconds: 90, p50_seconds: 90, p90_seconds: 90 },
        durations(RANA, 4, 60),
        durations(OMAR, 5, 120),
      ],
      roster: [{ id: RANA, name: 'Rana', status: 'active' }],
    });

    const report = await harness.asPrincipal(principal('agent'), (reports) =>
      reports.dashboard(QUERY),
    );

    expect(harness.rosterWhere).toEqual([{ id: RANA }]);
    expect(report.agents.map((row) => row.userId)).toEqual([RANA]);
    expect(report.summary.resolution.count).toBe(9);
  });

  it('still shows an agent the unattributed row', async () => {
    const harness = harnessFor({
      resolution: [
        { user_id: null, is_total: TOTAL, n: 6, avg_seconds: 90, p50_seconds: 90, p90_seconds: 90 },
        durations(RANA, 4, 60),
        durations(null, 2, 150),
      ],
      roster: [{ id: RANA, name: 'Rana', status: 'active' }],
    });

    const report = await harness.asPrincipal(principal('agent'), (reports) =>
      reports.dashboard(QUERY),
    );

    expect(report.agents.map((row) => row.userId)).toEqual([RANA, null]);
  });
});

describe('the response', () => {
  it('echoes the scope the caller actually got, not the one they asked for', async () => {
    // ADR 0004 invariant 2 narrows without rejecting, and the console shows a
    // notice beside a narrowed view — which it can only do if the response says
    // so. Without this an agent sees a smaller dashboard and no reason for it.
    const harness = harnessFor();

    const report = await harness.asPrincipal(principal('agent'), (reports) =>
      reports.dashboard({ ...QUERY, scope: 'all' }),
    );

    expect(report.scope).toBe('assigned');
  });

  it('answers an empty range with zero counts and null durations, and keeps every day', async () => {
    // Not zeros: "no ticket was answered" and "every ticket was answered
    // instantly" are different facts, and a zero renders as the second.
    const harness = harnessFor({
      series: [
        { day: '2026-08-01', created: 0, resolved: 0, first_response_median_seconds: null },
        { day: '2026-08-02', created: 0, resolved: 0, first_response_median_seconds: null },
        { day: '2026-08-03', created: 0, resolved: 0, first_response_median_seconds: null },
      ],
    });

    const report = await harness.asPrincipal(principal('supervisor'), (reports) =>
      reports.dashboard(QUERY),
    );

    expect(report.summary.volume).toEqual({
      created: 0,
      resolved: 0,
      closedWithoutResolution: 0,
    });
    expect(report.summary.firstResponse.medianSeconds).toBeNull();
    expect(report.series).toHaveLength(3);
    expect(report.agents).toEqual([]);
  });

  it('parses against the schema the contract publishes', async () => {
    // The response interceptor parses every payload against this and throws on a
    // mismatch, so a drift here is a 500 in development and a broken console in
    // production. Asserted at the source instead.
    const harness = harnessFor({
      volume: { created: 12, resolved: 9, closed_unworked: 2 },
      firstResponse: [
        {
          user_id: null,
          is_total: TOTAL,
          n: 9,
          avg_seconds: 300,
          p50_seconds: 240,
          p90_seconds: 900,
        },
        durations(RANA, 9, 240),
      ],
      resolution: [
        {
          user_id: null,
          is_total: TOTAL,
          n: 9,
          avg_seconds: 3600,
          p50_seconds: 3000,
          p90_seconds: 7200,
        },
        durations(RANA, 9, 3000),
      ],
      series: [{ day: '2026-08-01', created: 12, resolved: 9, first_response_median_seconds: 240 }],
      roster: [{ id: RANA, name: 'Rana', status: 'active' }],
    });

    const report = await harness.asPrincipal(principal('supervisor'), (reports) =>
      reports.dashboard(QUERY),
    );

    expect(DashboardMetricsResponseSchema.safeParse(report).success).toBe(true);
  });

  it('carries the resolved range, so two reports can be told apart', async () => {
    const harness = harnessFor();

    const report = await harness.asPrincipal(principal('supervisor'), (reports) =>
      reports.dashboard(QUERY),
    );

    expect(report.range).toEqual({
      from: '2026-08-01',
      to: '2026-08-03',
      timezone: 'Asia/Riyadh',
      startsAt: RANGE_ROW.starts_at.toISOString(),
      endsAt: RANGE_ROW.ends_at.toISOString(),
    });
  });
});

describe('the statements themselves', () => {
  it('applies the range as a half-open interval on each metric’s own anchor', async () => {
    // ADR 0010 decision 2: the four metrics do not share a column, so each range
    // predicate names the timestamp that makes its metric true. A single
    // `created_at` filter across all of them is the cohort anchoring the ADR
    // rejects for not being reproducible.
    const harness = harnessFor();

    await harness.asPrincipal(principal('supervisor'), (reports) => reports.dashboard(QUERY));

    const volume = harness.statements.find((sql) => sql.includes('closed_unworked')) ?? '';

    expect(volume).toContain('"created_at" >=');
    expect(volume).toContain('"resolved_at" >=');
    expect(volume).toContain('"closed_at" >=');
    expect(volume).toContain('"resolved_at" IS NULL');
  });

  it('groups both duration metrics by GROUPING SETS rather than summing in TypeScript', async () => {
    // The total and the per-agent rows come out of one statement, so they cannot
    // disagree even inside one response.
    const harness = harnessFor();

    await harness.asPrincipal(principal('supervisor'), (reports) => reports.dashboard(QUERY));

    const grouped = harness.statements.filter((sql) => sql.includes('GROUPING SETS'));

    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toContain('"first_response_user_id"');
    expect(grouped[1]).toContain('"resolved_by_user_id"');
  });

  it('scopes every aggregate, not just the summary', async () => {
    // The failure this catches is one statement missing the clause: a per-agent
    // breakdown over the whole tenant beside a correctly scoped summary is a
    // cross-permission leak that looks like a rounding disagreement.
    const harness = harnessFor();

    await harness.asPrincipal(principal('agent'), (reports) => reports.dashboard(QUERY));

    const aggregates = harness.statements.filter(
      (sql) =>
        sql.includes('closed_unworked') ||
        sql.includes('GROUPING SETS') ||
        sql.includes('generate_series'),
    );

    expect(aggregates).toHaveLength(4);
    expect(aggregates.every((sql) => sql.includes('"assigned_user_id" ='))).toBe(true);
  });

  it('never interpolates a value into a statement', async () => {
    // Every value is bound — the range, the zone, the principal's id and each of
    // their team ids. The only things in the text that look like identifiers are
    // column names written as literals in the service.
    const harness = harnessFor();

    await harness.asPrincipal(principal('agent'), (reports) => reports.dashboard(QUERY));

    for (const sql of harness.statements.slice(1)) {
      expect(sql).not.toContain(RANA);
      expect(sql).not.toContain(TEAM);
      expect(sql).not.toContain('2026-08-01');
      expect(sql).not.toContain('Asia/Riyadh');
    }
  });
});
