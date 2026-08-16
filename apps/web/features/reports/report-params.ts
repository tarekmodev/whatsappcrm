import {
  REPORT_RANGE_MAX_DAYS,
  ReportDateSchema,
  ReportScopeSchema,
  reportRangeDays,
  type DashboardMetricsQuery,
  type ReportExportSection,
  type ReportScope,
} from '@whatsappcrm/contracts';
import { DEFAULT_RANGE_DAYS } from '@/features/reports/constants';

/**
 * The dashboard's URL state, narrowed from untrusted query parameters.
 *
 * Every value is validated against the *contract's* own schemas rather than
 * cast, so the console and the API agree on what a range is — and a hand-edited
 * URL falls back to the default view instead of reaching a fetch as a malformed
 * query. That fallback is the same rule the ticket queue follows, and it matters
 * more here: `from` after `to`, or a range over a year, are the two refusals the
 * metrics endpoint answers `validation_failed` for, and neither is worth a round
 * trip to discover.
 *
 * The result is always a **complete** query — both dates resolved — which is what
 * lets the range filter, the metrics request and TAR-431's export URL all be
 * derived from one value rather than each re-deciding what "no range" means.
 */

export type ReportParams = DashboardMetricsQuery;

/**
 * `today` is passed in rather than read from the clock here, for two reasons and
 * both are load-bearing: a `Date.now()` inside a render makes the server's markup
 * and the client's differ, and a pure function is testable without freezing time.
 *
 * It is the *server's* today. The range itself is resolved in the tenant's own
 * timezone by the API (ADR 0009 decision 5), so only the default's endpoints —
 * never the numbers — can sit a day out for a tenant far from UTC, and any
 * interaction with the picker replaces them with dates the supervisor chose.
 */
export function parseReportParams(
  raw: {
    from: string | undefined;
    to: string | undefined;
    scope: string | undefined;
  },
  today: string,
): ReportParams {
  return {
    ...parseRange(raw.from, raw.to, today),
    scope: parseScope(raw.scope),
  };
}

function parseRange(
  from: string | undefined,
  to: string | undefined,
  today: string,
): { from: string; to: string } {
  const parsedFrom = ReportDateSchema.safeParse(from);
  const parsedTo = ReportDateSchema.safeParse(to);

  if (!parsedFrom.success || !parsedTo.success) {
    return defaultRange(today);
  }

  return isUsableRange(parsedFrom.data, parsedTo.data)
    ? { from: parsedFrom.data, to: parsedTo.data }
    : defaultRange(today);
}

/**
 * The applied query as a search string — the **one** serialisation both reads
 * use (ADR 0009 decision 1, part one).
 *
 * It lives here rather than beside the metrics client because the export is
 * fetched by the browser and `lib/api/reports.ts` is `server-only`: a second
 * copy for the client is precisely the drift this function exists to prevent.
 * Passing `section` adds the export's only extra parameter, which selects a
 * serialiser and touches nothing about the figures.
 */
export function reportSearchParams(
  query: DashboardMetricsQuery,
  section?: ReportExportSection,
): URLSearchParams {
  const params = new URLSearchParams({ from: query.from, to: query.to, scope: query.scope });

  if (query.assignedTeamId !== undefined) {
    params.set('assignedTeamId', query.assignedTeamId);
  }

  if (section !== undefined) {
    params.set('section', section);
  }

  return params;
}

/**
 * The two rules the endpoint refuses on, checked before anything is sent.
 *
 * Shared with the picker, which is what makes the disabled Apply button and the
 * URL narrowing above agree — a form that let through what the URL parser would
 * silently rewrite is a form that appears to do nothing.
 */
export function isUsableRange(from: string, to: string): boolean {
  return from <= to && reportRangeDays(from, to) <= REPORT_RANGE_MAX_DAYS;
}

export function defaultRange(today: string): { from: string; to: string } {
  return { from: shiftDays(today, -(DEFAULT_RANGE_DAYS - 1)), to: today };
}

/** The last `days` days including today, which is what a quick range means. */
export function presetRange(today: string, days: number): { from: string; to: string } {
  return { from: shiftDays(today, -(days - 1)), to: today };
}

function parseScope(value: string | undefined): ReportScope {
  const parsed = ReportScopeSchema.safeParse(value);

  // `all` is the contract's own default, and it is narrowed rather than refused
  // for a caller without `report:read_all` — so an unrecognised value falls back
  // to the widest thing the caller may actually be given.
  return parsed.success ? parsed.data : 'all';
}

const MS_PER_DAY = 86_400_000;

/**
 * Calendar arithmetic on a `YYYY-MM-DD`, in UTC.
 *
 * UTC deliberately: these are date *labels*, not instants, and adding a day to a
 * local-time value crosses a DST boundary twice a year and lands on the same
 * date it started from.
 */
export function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 'YYYY-MM-DD'.length);
}

/**
 * The server's calendar day, as the picker's ceiling and the default range's end.
 *
 * Called from a server component only — every route that renders the dashboard is
 * `force-dynamic`, and the value reaches the client as a prop rather than being
 * recomputed there, so nothing hydrates against a different day.
 */
export function todayInUtc(now: Date): string {
  return now.toISOString().slice(0, 'YYYY-MM-DD'.length);
}
