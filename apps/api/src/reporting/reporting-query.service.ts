import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  reportRangeDays,
  type AgentReportRow,
  type DailyPoint,
  type DashboardMetricsQuery,
  type DashboardMetricsResponse,
  type DurationStats,
  type SessionPrincipal,
  type TicketVolume,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { ReportRangeResolver, type ResolvedReportRange } from './report-range.resolver';
import { reportScopeClause, resolveReportScope } from './report-scope';
import { REPORT_PERCENTILES, REPORT_STATEMENT_TIMEOUT_MS } from './reporting.constants';
import { ReportTeamNotFoundError } from './reporting.errors';

/**
 * **The only place in the system that aggregates ticket metrics** (TAR-30, ADR
 * 0010 decision 1).
 *
 * That sentence is the design, not a description of it. TAR-30's second
 * acceptance criterion — "exported data matches what's shown on screen" —
 * cannot be satisfied by two code paths kept carefully in step, because nothing
 * keeps them in step except attention. It is satisfied by there being one path:
 * TAR-430's CSV route calls `dashboard()` with the same parsed query object the
 * JSON route passes and hands the result to a serialiser that touches no
 * database. There is no SQL on the export path, and there is no
 * `ReportGenerationService` that knows how to compute a median.
 *
 * Four properties fall out of that, and each is a way the numbers could
 * otherwise drift:
 *
 *   1. **One filter parse.** Both routes validate against schemas built from the
 *      same object shape in `@whatsappcrm/contracts/reporting`.
 *   2. **One rounding.** Durations are rounded to integer seconds in SQL, once.
 *      Whatever formats them for a human does it downstream of this.
 *   3. **One aggregation set.** The tenant total and the per-agent rows come out
 *      of a single statement using `GROUPING SETS`, so the total cannot disagree
 *      with the breakdown even inside one response.
 *   4. **One visibility predicate.** `report-scope.ts` builds it, from
 *      `assignedFilter` itself.
 *
 * ## Isolation
 *
 * Every statement runs on `TenantPrisma` inside **one** `$tenantTransaction`, so
 * the GUC is set once and TAR-48's RLS supplies the tenant equality on every one
 * of them. There is no `tenantId` parameter anywhere in this file. The
 * aggregates are hand-written SQL, which ADR 0002 decision 1 explicitly
 * anticipated for reporting — and that is safe precisely because isolation is
 * enforced by RLS rather than by the query: a missing tenant yields zero rows,
 * never every row.
 *
 * This module adds **no** `SystemPrisma` call site, so the written list in
 * `docs/reference/tenancy.md` is unchanged and there is no second tenant binding
 * point to review.
 *
 * ## Live aggregation, and its breaking point
 *
 * No rollup table and no materialised view (0010 decision 3). Zero staleness is
 * what makes parity trivially true; percentiles need the underlying rows because
 * medians do not compose across daily buckets; and a rollup would be a second
 * place the numbers are produced, which is the failure decision 1 exists to
 * prevent arriving through a side door. A materialised view additionally cannot
 * carry an RLS policy.
 *
 * The cost grows with the number of tickets in the range rather than with the
 * number of agents, so it has a breaking point — which is why `dashboard()` logs
 * the resolved range, the row counts and the elapsed time on every request. A
 * p95 that climbs with a tenant's history is the signal to start decision 3's
 * escalation, and it will not announce itself any other way.
 */

/** What a duration statistic is anchored on, and who it is attributed to. */
interface DurationAnchor {
  /** The timestamp whose presence makes the metric true, and which the range is applied to. */
  readonly at: Prisma.Sql;
  /** The column the per-agent rows group by. */
  readonly by: Prisma.Sql;
}

/**
 * The two duration metrics, as the only identifiers this file splices into SQL.
 *
 * Column names cannot be bound as parameters, so they are part of the statement
 * text — which makes it worth stating that these four fragments are literals in
 * this file, reachable only through a key of a TypeScript union. Nothing derived
 * from a request reaches `Prisma.raw` anywhere in this module.
 *
 * One statement builder over two anchors rather than two hand-written
 * statements: the percentile, the rounding and the grouping are written once, so
 * response time and resolution time cannot end up computed differently.
 */
const DURATION_ANCHORS = {
  firstResponse: {
    at: Prisma.raw('"first_response_at"'),
    by: Prisma.raw('"first_response_user_id"'),
  },
  resolution: {
    at: Prisma.raw('"resolved_at"'),
    by: Prisma.raw('"resolved_by_user_id"'),
  },
} as const satisfies Record<string, DurationAnchor>;

/** A metric with nothing behind it. Durations are null, never zero — see the contract. */
const NO_DURATIONS: DurationStats = {
  count: 0,
  averageSeconds: null,
  medianSeconds: null,
  p90Seconds: null,
};

interface VolumeRow {
  created: number;
  resolved: number;
  closed_unworked: number;
}

interface DurationRow {
  /** Null on the total row **and** on the unattributed row — `is_total` is what tells them apart. */
  user_id: string | null;
  /** `grouping()`: 1 for the row aggregated over everything, 0 for a per-agent row. */
  is_total: number;
  n: number;
  avg_seconds: number | null;
  p50_seconds: number | null;
  p90_seconds: number | null;
}

interface SeriesRow {
  /** Rendered as text in SQL: a `date` round-tripped through a JS `Date` is a timezone accident. */
  day: string;
  created: number;
  resolved: number;
  first_response_median_seconds: number | null;
}

/** One metric's rows, split the way `GROUPING SETS` returns them. */
interface GroupedDurations {
  readonly total: DurationStats;
  readonly byUser: ReadonlyMap<string, DurationStats>;
  readonly unattributed: DurationStats | null;
}

@Injectable()
export class ReportingQueryService {
  private readonly logger = new Logger(ReportingQueryService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly ranges: ReportRangeResolver,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The dashboard, for one range and one caller.
   *
   * One transaction and six statements: the range, the three volume counts, the
   * two duration aggregates, the daily series, and the roster of agents the
   * breakdown is rendered over. They are batched into one transaction rather
   * than issued separately so that every number in the response describes the
   * same instant — which is what makes "the export matches the screen" true of a
   * single call as well as of two.
   */
  async dashboard(query: DashboardMetricsQuery): Promise<DashboardMetricsResponse> {
    const principal = this.tenantContext.requirePrincipal();
    const startedAt = Date.now();

    const result = await this.prisma.$tenantTransaction(async (tx) => {
      // The value is a module constant and never anything from a request; `SET`
      // takes no bind parameters, which is why this one statement is `Unsafe`.
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${REPORT_STATEMENT_TIMEOUT_MS}`);

      await assertTeamExists(tx, query.assignedTeamId);

      const range = await this.ranges.resolve(tx, query);
      const scope = reportScopeClause(query, principal);

      // Sequential, not `Promise.all`. An interactive transaction is one
      // connection, so concurrent statements on it buy no parallelism at the
      // database and only make the order they reach it undefined.
      const volume = await readVolume(tx, range, scope);
      const firstResponse = await readDurations(tx, range, scope, DURATION_ANCHORS.firstResponse);
      const resolution = await readDurations(tx, range, scope, DURATION_ANCHORS.resolution);
      const series = await readSeries(tx, range, scope);
      const agents = await this.readAgents(tx, principal, firstResponse, resolution);

      return {
        range: range.range,
        scope: resolveReportScope(query.scope, principal),
        summary: { volume, firstResponse: firstResponse.total, resolution: resolution.total },
        agents,
        series,
      } satisfies DashboardMetricsResponse;
    });

    // The signal ADR 0010 decision 3's breaking point is otherwise invisible
    // behind. Counts and durations only — never a tenant's numbers and never a
    // name, per 0010's security section.
    this.logger.log(
      `Report served: ${reportRangeDays(query.from, query.to)} day(s), scope=${result.scope}, ` +
        `${result.agents.length} agent row(s), ${result.series.length} series point(s), ` +
        `${Date.now() - startedAt}ms`,
    );

    return result;
  }

  /**
   * The breakdown's rows: every agent the caller may be shown, each carrying its
   * two duration statistics, plus the unattributed row where there is one.
   *
   * ## Decision 6 — without `report:read_all`, this is one row
   *
   * ADR 0004 invariant 4 fixes *which tickets* are aggregated, and `scope`
   * already applies it. It does not say whether the result may be broken out by
   * colleague, and the difference matters: an agent's visible set includes their
   * team's tickets, so a per-agent table over it is a ranking of their
   * teammates. The summary and the series are unchanged and still cover the
   * visible set; what is withheld is the comparison, which no acceptance
   * criterion asks for on an agent's behalf.
   *
   * This **narrows** — it can never become a read channel around the matrix —
   * and it is one branch, so it is cheap to reverse if the product call goes the
   * other way (0010 open question 1).
   *
   * ## Why the roster is a query rather than the aggregate's own rows
   *
   * A supervisor comparing a team needs the **zero** rows: an agent who resolved
   * nothing in the range is a fact about the range, and their absence reads as a
   * loading bug. The aggregates cannot supply them — an agent with no tickets in
   * the range produces no group — so the active roster is read separately and
   * zero-filled. An *inactive* user is included only when they have work in the
   * range, so a departed contractor's numbers do not vanish out of a closed
   * period.
   */
  private async readAgents(
    tx: Prisma.TransactionClient,
    principal: SessionPrincipal,
    firstResponse: GroupedDurations,
    resolution: GroupedDurations,
  ): Promise<AgentReportRow[]> {
    const mayCompare = principal.permissions.includes('report:read_all');
    const attributed = [...new Set([...firstResponse.byUser.keys(), ...resolution.byUser.keys()])];

    const roster = await tx.user.findMany({
      where: mayCompare
        ? { OR: [{ status: 'active' }, { id: { in: attributed } }] }
        : { id: principal.userId },
      // Exactly the three fields the row publishes. `users` is a wide table and
      // this is a per-request read; a bare `findMany` would fetch the password
      // hash and the lockout columns to render a name.
      select: { id: true, name: true, status: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });

    const rows: AgentReportRow[] = roster.map((user) => ({
      userId: user.id,
      name: user.name,
      isActive: user.status === 'active',
      // The same number as `resolution.count`, published separately because it
      // is the column a supervisor scans first and the CSV's `TOTAL` row has to
      // line up with it.
      ticketsResolved: resolution.byUser.get(user.id)?.count ?? 0,
      firstResponse: firstResponse.byUser.get(user.id) ?? NO_DURATIONS,
      resolution: resolution.byUser.get(user.id) ?? NO_DURATIONS,
    }));

    if (firstResponse.unattributed === null && resolution.unattributed === null) {
      return rows;
    }

    // Last, and rendered rather than hidden: this is the work whose responder or
    // resolver was never recorded, and dropping it would leave a table that does
    // not add up to the summary above it with no explanation of the difference.
    // `isActive` is false because it describes no account at all.
    return [
      ...rows,
      {
        userId: null,
        name: null,
        isActive: false,
        ticketsResolved: resolution.unattributed?.count ?? 0,
        firstResponse: firstResponse.unattributed ?? NO_DURATIONS,
        resolution: resolution.unattributed ?? NO_DURATIONS,
      },
    ];
  }
}

/**
 * Refuses a team filter naming a team this tenant does not have, before any
 * aggregate runs.
 *
 * The lookup goes through the transaction's client under RLS, so another
 * tenant's team simply is not there — the id in the query string is never
 * trusted as a key. Without this the filter would match nothing and the caller
 * would get a valid-looking dashboard of zeroes, which is worse than an error
 * because it is indistinguishable from a quiet week.
 */
async function assertTeamExists(
  tx: Prisma.TransactionClient,
  teamId: string | undefined,
): Promise<void> {
  if (teamId === undefined) {
    return;
  }

  const team = await tx.team.findUnique({ where: { id: teamId }, select: { id: true } });

  if (team === null) {
    throw new ReportTeamNotFoundError(teamId);
  }
}

/**
 * The three counts, as three independent index range scans rather than one `OR`
 * across three timestamp columns — which no single index can serve as a start
 * condition, so the planner would read the tenant's whole history and filter.
 *
 * `::int` on each count because `count(*)` is `bigint`, which Prisma hands back
 * as a `BigInt` that `JSON.stringify` refuses to serialise. A tenant with more
 * than two billion tickets in one range has a different problem.
 */
async function readVolume(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  range: ResolvedReportRange,
  scope: Prisma.Sql,
): Promise<TicketVolume> {
  const [row] = await tx.$queryRaw<VolumeRow[]>`
    SELECT
      (SELECT count(*)::int FROM "public"."tickets"
        WHERE "created_at" >= ${range.startsAt} AND "created_at" < ${range.endsAt}
        ${scope})                                                        AS created,
      (SELECT count(*)::int FROM "public"."tickets"
        WHERE "resolved_at" >= ${range.startsAt} AND "resolved_at" < ${range.endsAt}
        ${scope})                                                        AS resolved,
      (SELECT count(*)::int FROM "public"."tickets"
        WHERE "closed_at" >= ${range.startsAt} AND "closed_at" < ${range.endsAt}
          AND "resolved_at" IS NULL
        ${scope})                                                        AS closed_unworked
  `;

  return {
    created: row?.created ?? 0,
    resolved: row?.resolved ?? 0,
    closedWithoutResolution: row?.closed_unworked ?? 0,
  };
}

/**
 * One metric's total **and** its per-agent rows, from one statement.
 *
 * `GROUPING SETS ((by), ())` is the point: the row with `is_total = 1` is
 * computed over exactly the rows the per-agent rows partition, so the summary
 * cannot disagree with the breakdown. Two statements summed in TypeScript would
 * have to be kept equal by attention.
 *
 * ⚠️ The total's median is **not** the median of the per-agent medians, and must
 * never be presented as though the column sums. That is a property of
 * percentiles, not of this query.
 *
 * The empty grouping set yields a row even over zero input rows — count 0 and
 * null durations, which is exactly what the contract requires for an empty
 * range.
 */
async function readDurations(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  range: ResolvedReportRange,
  scope: Prisma.Sql,
  anchor: DurationAnchor,
): Promise<GroupedDurations> {
  const rows = await tx.$queryRaw<DurationRow[]>`
    SELECT
      ${anchor.by}                                                          AS user_id,
      grouping(${anchor.by})                                                AS is_total,
      count(*)::int                                                         AS n,
      round(extract(epoch FROM avg(${anchor.at} - "created_at")))::int       AS avg_seconds,
      round(extract(epoch FROM percentile_cont(${REPORT_PERCENTILES.median}::float8) WITHIN GROUP (
        ORDER BY ${anchor.at} - "created_at")))::int                        AS p50_seconds,
      round(extract(epoch FROM percentile_cont(${REPORT_PERCENTILES.p90}::float8) WITHIN GROUP (
        ORDER BY ${anchor.at} - "created_at")))::int                        AS p90_seconds
    FROM "public"."tickets"
    WHERE ${anchor.at} >= ${range.startsAt} AND ${anchor.at} < ${range.endsAt}
    ${scope}
    GROUP BY GROUPING SETS ((${anchor.by}), ())
  `;

  const byUser = new Map<string, DurationStats>();
  let total = NO_DURATIONS;
  let unattributed: DurationStats | null = null;

  for (const row of rows) {
    if (row.is_total === 1) {
      total = toDurationStats(row);
    } else if (row.user_id === null) {
      unattributed = toDurationStats(row);
    } else {
      byUser.set(row.user_id, toDurationStats(row));
    }
  }

  return { total, byUser, unattributed };
}

/**
 * Every day in the range, zero-filled, bucketed in the tenant's own days.
 *
 * Three CTEs rather than one pass, for the same reason the volume statement is
 * three subqueries: each metric is anchored on a different column, and one query
 * over three timestamp ranges has no index to start from. `generate_series`
 * supplies the spine, so a day with no activity is a zero row rather than a gap
 * the console has to reconstruct.
 *
 * `(… AT TIME ZONE $tz)::date` is DST-correct in a way that adding
 * `interval '1 day'` to a `timestamptz` is not, and the day is rendered as text
 * here rather than in TypeScript: a Postgres `date` round-tripped through a JS
 * `Date` picks up a timezone it never had.
 */
async function readSeries(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  range: ResolvedReportRange,
  scope: Prisma.Sql,
): Promise<DailyPoint[]> {
  const { from, to, timezone } = range.range;

  const rows = await tx.$queryRaw<SeriesRow[]>`
    WITH days AS (
      SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS day
    ),
    created AS (
      SELECT ("created_at" AT TIME ZONE ${timezone})::date AS day, count(*)::int AS n
        FROM "public"."tickets"
       WHERE "created_at" >= ${range.startsAt} AND "created_at" < ${range.endsAt}
       ${scope}
       GROUP BY 1
    ),
    resolved AS (
      SELECT ("resolved_at" AT TIME ZONE ${timezone})::date AS day, count(*)::int AS n
        FROM "public"."tickets"
       WHERE "resolved_at" >= ${range.startsAt} AND "resolved_at" < ${range.endsAt}
       ${scope}
       GROUP BY 1
    ),
    responded AS (
      SELECT ("first_response_at" AT TIME ZONE ${timezone})::date AS day,
             round(extract(epoch FROM percentile_cont(${REPORT_PERCENTILES.median}::float8) WITHIN GROUP (
               ORDER BY "first_response_at" - "created_at")))::int AS p50
        FROM "public"."tickets"
       WHERE "first_response_at" >= ${range.startsAt} AND "first_response_at" < ${range.endsAt}
       ${scope}
       GROUP BY 1
    )
    SELECT to_char(d.day, 'YYYY-MM-DD')  AS day,
           coalesce(c.n, 0)              AS created,
           coalesce(r.n, 0)              AS resolved,
           f.p50                         AS first_response_median_seconds
      FROM days d
      LEFT JOIN created   c ON c.day = d.day
      LEFT JOIN resolved  r ON r.day = d.day
      LEFT JOIN responded f ON f.day = d.day
     ORDER BY d.day
  `;

  return rows.map((row) => ({
    date: row.day,
    created: row.created,
    resolved: row.resolved,
    firstResponseMedianSeconds: row.first_response_median_seconds,
  }));
}

/**
 * One aggregate row as the contract publishes it.
 *
 * The null-when-empty rule is enforced here rather than trusted to SQL: a group
 * with rows always has a median, and a group without rows only exists as the
 * empty grouping set — but `DurationStatsSchema` refines on the correspondence,
 * so making it structural costs one guard and removes a class of 500 from the
 * serializer.
 */
function toDurationStats(row: DurationRow): DurationStats {
  if (row.n === 0) {
    return NO_DURATIONS;
  }

  return {
    count: row.n,
    averageSeconds: row.avg_seconds,
    medianSeconds: row.p50_seconds,
    p90Seconds: row.p90_seconds,
  };
}
