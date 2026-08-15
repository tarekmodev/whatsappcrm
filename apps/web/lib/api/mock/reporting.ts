import 'server-only';

import {
  roleHasPermission,
  type AgentReportRow,
  type DailyPoint,
  type DashboardMetricsQuery,
  type DashboardMetricsResponse,
  type DurationStats,
  type ReportMetrics,
  type ReportScope,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import type { MockTicket, MockUser } from '@/lib/api/mock/fixtures';

/**
 * The dashboard aggregate, standing in for TAR-428's `ReportingQueryService`
 * until it lands (ADR 0009).
 *
 * It is a mirror of the four statements in 0009's Interfaces section rather than
 * a convenient fake, because each rule it copies is something the screen above it
 * claims to be true:
 *
 *   1. **Every metric is anchored on the event that makes it true**, never on
 *      `created_at`. Resolution time is over tickets *resolved* in the range,
 *      whenever they arrived (decision 2). A fixture layer that anchored
 *      everything on creation would make the dashboard's own copy a lie, and
 *      would hide the reproducibility property the whole design turns on.
 *   2. **Attribution is historical.** The responder and resolver are read from
 *      the ticket's recorded columns, never from `assignedUserId` — a ticket
 *      reassigned after the fact keeps its numbers on the agent who did the work
 *      (decision 4).
 *   3. **The total and the breakdown come from one pass**, which is what the
 *      real query's `GROUPING SETS` buys: the summary cannot disagree with the
 *      rows, and the total's median is the median over every ticket rather than
 *      the median of the per-agent medians.
 *   4. **Without `report:read_all` the breakdown is one row** — the caller's own,
 *      plus the unattributed row where it applies (decision 6). It narrows, never
 *      widens, so it cannot become a read channel around the matrix.
 *
 * Two honest departures from the real thing, both consequences of there being no
 * database here: the range is bucketed in **UTC**, because the mock has no
 * `tenant_settings` row to read a timezone from — which is the same fallback
 * 0009 specifies for a tenant that has none — and percentiles are computed in
 * TypeScript rather than by `percentile_cont`, with the same linear
 * interpolation.
 */

export interface DashboardMetricsInput {
  readonly principal: SessionPrincipal;
  readonly query: DashboardMetricsQuery;
  /** Already narrowed to the caller's tenant by the handler. */
  readonly tickets: readonly MockTicket[];
  readonly users: readonly MockUser[];
}

/** What the mock reports when it has no `tenant_settings` row to read (0009). */
const FALLBACK_TIMEZONE = 'UTC';

const MS_PER_DAY = 86_400_000;
const MS_PER_SECOND = 1000;

export function dashboardMetrics({
  principal,
  query,
  tickets,
  users,
}: DashboardMetricsInput): DashboardMetricsResponse {
  const canReadAll = roleHasPermission(principal.role, 'report:read_all');
  // Narrowed, never refused: an agent opening a supervisor's link gets a valid
  // dashboard with less in it (0004 invariant 2).
  const scope: ReportScope = canReadAll ? query.scope : 'assigned';
  const startsAt = dayStart(query.from);
  const endsAt = dayStart(nextDay(query.to));

  const visible = tickets
    .filter((ticket) => scope === 'all' || isAssignedTo(ticket, principal))
    .filter(
      (ticket) =>
        query.assignedTeamId === undefined || ticket.assignedTeamId === query.assignedTeamId,
    );

  const responses = visible
    .filter((ticket) => isWithin(ticket.firstRespondedAt, startsAt, endsAt))
    .map((ticket) => ({
      userId: ticket.firstResponseUserId,
      seconds: elapsedSeconds(ticket.createdAt, ticket.firstRespondedAt),
    }));

  const resolutions = visible
    .filter((ticket) => isWithin(ticket.resolvedAt, startsAt, endsAt))
    .map((ticket) => ({
      userId: ticket.resolvedByUserId,
      seconds: elapsedSeconds(ticket.createdAt, ticket.resolvedAt),
    }));

  const summary: ReportMetrics = {
    volume: {
      created: visible.filter((ticket) => isWithin(ticket.createdAt, startsAt, endsAt)).length,
      resolved: resolutions.length,
      closedWithoutResolution: visible.filter(
        (ticket) => ticket.resolvedAt === null && isWithin(ticket.closedAt, startsAt, endsAt),
      ).length,
    },
    firstResponse: durationStats(responses.map((entry) => entry.seconds)),
    resolution: durationStats(resolutions.map((entry) => entry.seconds)),
  };

  return {
    range: {
      from: query.from,
      to: query.to,
      timezone: FALLBACK_TIMEZONE,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
    },
    scope,
    summary,
    agents: agentRows({ principal, canReadAll, users, responses, resolutions }),
    series: dailySeries(query.from, query.to, visible),
  };
}

interface AttributedDuration {
  readonly userId: string | null;
  readonly seconds: number;
}

/**
 * One row per agent with work in the range, plus every active member of the
 * tenant zero-filled.
 *
 * The zero rows are not padding: a supervisor comparing a team needs to see that
 * somebody handled nothing, and their absence from the table reads as a loading
 * bug rather than as a fact.
 */
function agentRows({
  principal,
  canReadAll,
  users,
  responses,
  resolutions,
}: {
  principal: SessionPrincipal;
  canReadAll: boolean;
  users: readonly MockUser[];
  responses: readonly AttributedDuration[];
  resolutions: readonly AttributedDuration[];
}): AgentReportRow[] {
  const byId = new Map(users.map((user) => [user.id, user]));
  const withWork = new Set<string | null>([
    ...responses.map((entry) => entry.userId),
    ...resolutions.map((entry) => entry.userId),
  ]);

  const seeded: (string | null)[] = canReadAll
    ? users.filter((user) => user.status === 'active').map((user) => user.id)
    : // Decision 6: their own row and nothing about a colleague.
      [principal.userId];

  const keys = [
    ...new Set([...seeded, ...[...withWork].filter((id) => canReadAll || id === null)]),
  ];

  return keys
    .map((userId) => {
      const user = userId === null ? undefined : byId.get(userId);

      return {
        userId,
        name: user?.displayName ?? null,
        // An unrecorded responder is not an inactive agent; it is nobody, and the
        // row says so in words rather than through a status badge.
        isActive: userId === null ? false : user?.status === 'active',
        ticketsResolved: resolutions.filter((entry) => entry.userId === userId).length,
        firstResponse: durationStats(secondsFor(responses, userId)),
        resolution: durationStats(secondsFor(resolutions, userId)),
      };
    })
    .sort(byResolvedThenName);
}

function secondsFor(entries: readonly AttributedDuration[], userId: string | null): number[] {
  return entries.filter((entry) => entry.userId === userId).map((entry) => entry.seconds);
}

/** Busiest first, then alphabetically, with the unattributed row last. */
function byResolvedThenName(left: AgentReportRow, right: AgentReportRow): number {
  if ((left.userId === null) !== (right.userId === null)) {
    return left.userId === null ? 1 : -1;
  }

  return (
    right.ticketsResolved - left.ticketsResolved ||
    (left.name ?? '').localeCompare(right.name ?? '')
  );
}

/**
 * Every tenant-local day in the range, zero-filled — a gap in the middle of a
 * chart is a day nobody worked, and it has to be drawn as one rather than
 * skipped.
 */
function dailySeries(from: string, to: string, tickets: readonly MockTicket[]): DailyPoint[] {
  const points: DailyPoint[] = [];

  for (let date = from; date <= to; date = nextDay(date)) {
    const responded = tickets
      .filter((ticket) => dayOf(ticket.firstRespondedAt) === date)
      .map((ticket) => elapsedSeconds(ticket.createdAt, ticket.firstRespondedAt));

    points.push({
      date,
      created: tickets.filter((ticket) => dayOf(ticket.createdAt) === date).length,
      resolved: tickets.filter((ticket) => dayOf(ticket.resolvedAt) === date).length,
      firstResponseMedianSeconds: responded.length === 0 ? null : percentile(responded, 0.5),
    });
  }

  return points;
}

/**
 * `count`, mean, p50 and p90 over one set of durations.
 *
 * The three durations are **null when nothing was measured**, never zero: the
 * contract refuses a body where they disagree, so a fixture layer that reported
 * zeros here would fail at the parse rather than reaching the screen.
 */
export function durationStats(seconds: readonly number[]): DurationStats {
  if (seconds.length === 0) {
    return { count: 0, averageSeconds: null, medianSeconds: null, p90Seconds: null };
  }

  const total = seconds.reduce((sum, value) => sum + value, 0);

  return {
    count: seconds.length,
    averageSeconds: Math.round(total / seconds.length),
    medianSeconds: percentile(seconds, 0.5),
    p90Seconds: percentile(seconds, 0.9),
  };
}

/**
 * `percentile_cont`, mirrored: linear interpolation between the two values the
 * fractional index falls between, not a nearest-rank pick. The distinction shows
 * up on small samples, which is every sample in a fixture set.
 */
function percentile(seconds: readonly number[], fraction: number): number {
  const sorted = [...seconds].sort((left, right) => left - right);
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;

  return Math.round(low + (high - low) * (position - lower));
}

function isAssignedTo(ticket: MockTicket, principal: SessionPrincipal): boolean {
  return (
    ticket.assignedUserId === principal.userId ||
    (ticket.assignedTeamId !== null && principal.teamIds.includes(ticket.assignedTeamId))
  );
}

/** Half-open, exactly like the SQL: `>= startsAt AND < endsAt`. */
function isWithin(timestamp: string | null, startsAt: number, endsAt: number): boolean {
  if (timestamp === null) {
    return false;
  }

  const at = Date.parse(timestamp);

  return at >= startsAt && at < endsAt;
}

function elapsedSeconds(from: string, to: string | null): number {
  if (to === null) {
    throw new Error('Mock reporting measured a duration with no end.');
  }

  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_SECOND);
}

function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function nextDay(date: string): string {
  return isoDate(dayStart(date) + MS_PER_DAY);
}

/** The UTC calendar day a timestamp falls on, or `null` for an absent one. */
function dayOf(timestamp: string | null): string | null {
  return timestamp === null ? null : isoDate(Date.parse(timestamp));
}

function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 'YYYY-MM-DD'.length);
}
