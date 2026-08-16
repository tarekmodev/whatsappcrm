import { Injectable, Logger } from '@nestjs/common';
import type { DashboardMetricsQuery, ReportRange } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';

/** One row, always: the CTE below aggregates, so a tenant with no settings still answers. */
interface ResolvedRangeRow {
  timezone: string;
  starts_at: Date;
  ends_at: Date;
  fell_back: boolean;
}

/**
 * The range as both halves of the system need it: the dates the caller asked
 * for, and the instants the statements compare against.
 */
export interface ResolvedReportRange {
  readonly range: ReportRange;
  /** Inclusive. */
  readonly startsAt: Date;
  /** Exclusive — `to` + 1 day at local midnight. */
  readonly endsAt: Date;
}

/**
 * Turns two tenant-local calendar dates into a half-open instant interval
 * (TAR-30, ADR 0010 decision 5).
 *
 * ## Why the zone is the server's decision
 *
 * `tenant_settings.timezone` is already the authority — its schema comment names
 * report bucketing as one of the three things it drives — and a supervisor in
 * Riyadh picking "1–7 August" means their week, not UTC's. Letting the client
 * send instants instead would make every future caller responsible for knowing
 * that zone and agreeing on it, with no way for the server to check that they
 * did: the export, a scheduled report and a support engineer with `curl` would
 * each have to get it right independently.
 *
 * ## Why the conversion happens in SQL
 *
 * So that the range endpoints and the daily buckets in the series are computed
 * by the same engine, with the same tz database and the same DST rules, in the
 * same transaction. Resolving the endpoints in Node and the buckets in Postgres
 * is two implementations of "when does a day start here", and they disagree
 * exactly twice a year.
 *
 * **The known edge**: in a zone that shifts at midnight, a local midnight can
 * fail to exist and Postgres resolves it forward. That moves a boundary by an
 * hour once a year. Recorded rather than handled — the alternative is a stored
 * report entity, which v1 has none of.
 *
 * ## A tenant with no settings row
 *
 * Falls back to UTC and logs it once per request. It is a provisioning gap
 * rather than a caller error: the tenant gets a valid report whose day
 * boundaries are UTC's until the row exists, which is visible in the response —
 * `range.timezone` echoes what was actually used.
 */
@Injectable()
export class ReportRangeResolver {
  private readonly logger = new Logger(ReportRangeResolver.name);

  /**
   * One round trip, inside the caller's transaction so the zone read and the
   * aggregates that use it cannot see different rows.
   *
   * `max(timezone)` over a table RLS has already narrowed to one row is that
   * row's value, and it is an aggregate so the statement answers one row even
   * when there is no settings row at all — which is what removes the branch
   * that would otherwise need a second query.
   */
  async resolve(
    tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
    query: Pick<DashboardMetricsQuery, 'from' | 'to'>,
  ): Promise<ResolvedReportRange> {
    const [row] = await tx.$queryRaw<ResolvedRangeRow[]>`
      WITH zone AS (
        SELECT coalesce(max("timezone"), 'UTC') AS timezone,
               count(*) = 0                     AS fell_back
          FROM "public"."tenant_settings"
      )
      SELECT z.timezone                                                         AS timezone,
             (${query.from}::date)::timestamp AT TIME ZONE z.timezone           AS starts_at,
             ((${query.to}::date + 1))::timestamp AT TIME ZONE z.timezone       AS ends_at,
             z.fell_back                                                        AS fell_back
        FROM zone z
    `;

    if (row === undefined) {
      // Unreachable: the CTE aggregates, so it yields one row for any table
      // contents. A fault if it ever happens, and reported as one rather than
      // silently defaulted — a report over a range nobody chose is worse than an
      // error.
      throw new Error('The report range query returned no row.');
    }

    if (row.fell_back) {
      this.logger.warn(
        'This tenant has no tenant_settings row; report day boundaries fall back to UTC. ' +
          'Provisioning writes that row — a tenant without one predates it or failed halfway.',
      );
    }

    return {
      range: {
        from: query.from,
        to: query.to,
        timezone: row.timezone,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
      },
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    };
  }
}
