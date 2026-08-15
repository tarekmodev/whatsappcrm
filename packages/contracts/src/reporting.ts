import { z } from 'zod';
import { IanaTimezoneSchema, IdSchema, TimestampSchema } from './common';

/**
 * The reporting dashboard and its export, per
 * `docs/architecture/0010-reporting-dashboard-and-export.md` (TAR-426).
 *
 * Published here rather than beside the metrics API because four stories build
 * against it at once: TAR-428 implements `GET /reports/dashboard`, TAR-429 the
 * dashboard screen, TAR-430 the CSV route and TAR-431 the export control. The
 * shapes are the contract between them, and the *query* shape in particular is
 * what makes "the export matches what is on screen" structural — both routes
 * validate against schemas built from one object shape, so the range the export
 * used and the range the screen shows are the same parsed value rather than two
 * readings of the same query string (0010 decision 1).
 */

/** A year and a day. Bounds the one query whose row count the caller chooses. */
export const REPORT_RANGE_MAX_DAYS = 366;

/** Tenant-local calendar day, `YYYY-MM-DD`. Never an instant — see 0010 decision 5. */
export const ReportDateSchema = z.iso.date();

/**
 * Which tickets the aggregate covers. **Narrowed, never rejected** — a caller
 * without `report:read_all` asking for `all` gets their own and their teams'
 * work rather than a 403, so a supervisor's shared link still renders for an
 * agent (0004 invariant 2).
 *
 * Named rather than left inline in the query shape below so the console can
 * narrow an untrusted `?scope=` against the contract instead of re-declaring the
 * two values it accepts.
 */
export const REPORT_SCOPES = ['assigned', 'all'] as const;
export const ReportScopeSchema = z.enum(REPORT_SCOPES);

/**
 * Every duration statistic in this file. `count` is the number of tickets the
 * statistic was computed over; the three durations are **null when `count` is
 * zero**, never `0`, because "no ticket was answered" and "every ticket was
 * answered instantly" are different facts.
 */
export const DurationStatsSchema = z
  .object({
    count: z.int().nonnegative(),
    averageSeconds: z.int().nonnegative().nullable(),
    medianSeconds: z.int().nonnegative().nullable(),
    p90Seconds: z.int().nonnegative().nullable(),
  })
  .refine((v) => (v.count === 0) === (v.medianSeconds === null), {
    message: 'Durations are null exactly when count is zero',
  });

export const TicketVolumeSchema = z.object({
  /** Tickets whose `created_at` falls in the range. */
  created: z.int().nonnegative(),
  /** Tickets whose `resolved_at` falls in the range, whenever they were created. */
  resolved: z.int().nonnegative(),
  /** Closed in the range having never been resolved — the "closed unworked" signal. */
  closedWithoutResolution: z.int().nonnegative(),
});

export const ReportMetricsSchema = z.object({
  volume: TicketVolumeSchema,
  firstResponse: DurationStatsSchema,
  resolution: DurationStatsSchema,
});

/**
 * One agent's row. `userId` is **null for the unattributed row** — work whose
 * responder or resolver was never recorded (a pre-backfill ticket, a resolution
 * with no actor). It is rendered, not hidden, so the table adds up to the summary.
 */
export const AgentReportRowSchema = z.object({
  userId: IdSchema.nullable(),
  name: z.string().nullable(),
  /** False for a suspended or removed agent who still has work in the range. */
  isActive: z.boolean(),
  ticketsResolved: z.int().nonnegative(),
  firstResponse: DurationStatsSchema,
  resolution: DurationStatsSchema,
});

/** One tenant-local day. Every day in the range is present, zero-filled. */
export const DailyPointSchema = z.object({
  date: ReportDateSchema,
  created: z.int().nonnegative(),
  resolved: z.int().nonnegative(),
  firstResponseMedianSeconds: z.int().nonnegative().nullable(),
});

export const ReportRangeSchema = z.object({
  from: ReportDateSchema,
  to: ReportDateSchema,
  timezone: IanaTimezoneSchema,
  /** The resolved half-open interval, inclusive. */
  startsAt: TimestampSchema,
  /** Exclusive: `to` + 1 day at local midnight. */
  endsAt: TimestampSchema,
});

/**
 * The query shape, declared once as a plain object so that the JSON and CSV
 * routes are the same parameters by construction and not by convention
 * (0010 decision 1). `.refine` returns an effects schema with no `.extend`,
 * which is why the shape and the rules are separate.
 */
const dashboardQueryShape = {
  from: ReportDateSchema,
  to: ReportDateSchema,
  /** Narrowed, never rejected, per 0004 invariant 2. */
  scope: ReportScopeSchema.default('all'),
  assignedTeamId: IdSchema.optional(),
};

function withRangeRules<T extends z.ZodObject<{ from: z.ZodType<string>; to: z.ZodType<string> }>>(
  schema: T,
) {
  return schema
    .refine((v) => v.from <= v.to, { message: '`from` must not be after `to`' })
    .refine((v) => reportRangeDays(v.from, v.to) <= REPORT_RANGE_MAX_DAYS, {
      message: `Range must not exceed ${REPORT_RANGE_MAX_DAYS} days`,
    });
}

/** Inclusive day count. Exported so the console can disable the picker at the same bound. */
export function reportRangeDays(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

export const DashboardMetricsQuerySchema = withRangeRules(z.object(dashboardQueryShape));

export const REPORT_EXPORT_SECTIONS = ['summary', 'agents', 'series'] as const;
export const ReportExportSectionSchema = z.enum(REPORT_EXPORT_SECTIONS);

export const DashboardExportQuerySchema = withRangeRules(
  z.object({ ...dashboardQueryShape, section: ReportExportSectionSchema.default('agents') }),
);

export const DashboardMetricsResponseSchema = z.object({
  range: ReportRangeSchema,
  /** What the caller actually got, after narrowing. */
  scope: ReportScopeSchema,
  summary: ReportMetricsSchema,
  /** One row per agent with work in the range, plus every active agent, zero-filled. */
  agents: z.array(AgentReportRowSchema),
  series: z.array(DailyPointSchema),
});

export type ReportScope = z.infer<typeof ReportScopeSchema>;
export type DurationStats = z.infer<typeof DurationStatsSchema>;
export type TicketVolume = z.infer<typeof TicketVolumeSchema>;
export type ReportMetrics = z.infer<typeof ReportMetricsSchema>;
export type AgentReportRow = z.infer<typeof AgentReportRowSchema>;
export type DailyPoint = z.infer<typeof DailyPointSchema>;
export type ReportRange = z.infer<typeof ReportRangeSchema>;
export type ReportExportSection = z.infer<typeof ReportExportSectionSchema>;
export type DashboardMetricsQuery = z.infer<typeof DashboardMetricsQuerySchema>;
export type DashboardExportQuery = z.infer<typeof DashboardExportQuerySchema>;
export type DashboardMetricsResponse = z.infer<typeof DashboardMetricsResponseSchema>;
