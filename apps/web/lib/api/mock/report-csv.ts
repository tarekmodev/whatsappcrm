import 'server-only';

import type {
  AgentReportRow,
  DashboardMetricsResponse,
  DurationStats,
  ReportExportSection,
} from '@whatsappcrm/contracts';

/**
 * The CSV standing in for TAR-430's `DashboardCsvSerialiser` until it lands
 * — ADR 0010 (reporting dashboard and export) decision 7 — exactly as
 * `mock/reporting.ts` stands in for TAR-428's query service.
 *
 * **It takes the dashboard response and nothing else.** That is the whole point
 * rather than a convenience: the mock export route hands it the object the mock
 * *metrics* route returned, so in mock mode the file and the screen cannot carry
 * different numbers — the same structural guarantee decision 1 gives the real
 * pair, reproduced in the layer QA can actually run today. There is no fixture
 * here, no second aggregation and no arithmetic.
 *
 * What it reproduces from decision 7, because each is something a spreadsheet or
 * a supervisor notices:
 *
 *   * **Integer seconds, never a formatted duration.** A spreadsheet can compute
 *     on `8040` and cannot compute on "2h 14m", and formatting stays in the
 *     console's one formatter (`features/reports/presentation.ts`).
 *   * **A null duration is an empty cell, never `0`** — "nothing was answered"
 *     and "everything was answered instantly" are different facts.
 *   * **The `agents` file ends with a `TOTAL` row that is the summary**, in the
 *     same columns, which is what makes "the export matches the screen" true of
 *     the headline figures inside the file itself.
 *   * **UTF-8 with a BOM, RFC 4180 quoting, CRLF endings.** Excel on Windows
 *     reads a BOM-less UTF-8 CSV as the local code page, and agent names in this
 *     product are routinely Arabic.
 *   * **Formula injection is neutralised** on every text field, not only names.
 */

export function dashboardCsv(
  response: DashboardMetricsResponse,
  section: ReportExportSection,
): string {
  return BOM + toCsv(rowsFor(response, section));
}

/**
 * `report-<section>-<from>-<to>.csv`, per ADR 0010 (reporting dashboard and
 * export) decision 7.
 */
export function dashboardCsvFileName(
  range: DashboardMetricsResponse['range'],
  section: ReportExportSection,
): string {
  return `report-${section}-${range.from}-${range.to}.csv`;
}

const BOM = '﻿';

/**
 * The row for work whose responder or resolver was never recorded. Named rather
 * than left blank for the same reason the table names it: an empty first cell
 * reads as a broken export rather than as a fact about the data.
 */
const UNATTRIBUTED_LABEL = 'Not recorded';

function rowsFor(
  response: DashboardMetricsResponse,
  section: ReportExportSection,
): readonly (readonly string[])[] {
  if (section === 'summary') {
    return summaryRows(response);
  }

  if (section === 'series') {
    return seriesRows(response);
  }

  return agentRows(response);
}

function summaryRows(response: DashboardMetricsResponse): readonly (readonly string[])[] {
  const { range, scope, summary } = response;

  return [
    [
      'from',
      'to',
      'timezone',
      'scope',
      'tickets_created',
      'tickets_resolved',
      'tickets_closed_without_resolution',
      ...durationHeaders('first_response'),
      ...durationHeaders('resolution'),
    ],
    [
      range.from,
      range.to,
      range.timezone,
      scope,
      String(summary.volume.created),
      String(summary.volume.resolved),
      String(summary.volume.closedWithoutResolution),
      ...durationCells(summary.firstResponse),
      ...durationCells(summary.resolution),
    ],
  ];
}

function agentRows(response: DashboardMetricsResponse): readonly (readonly string[])[] {
  const { summary, agents } = response;

  return [
    [
      'agent',
      'is_active',
      'tickets_resolved',
      ...durationHeaders('first_response'),
      ...durationHeaders('resolution'),
    ],
    ...agents.map(agentRow),
    // The summary, in the agents' own columns. `is_active` is blank because a
    // total is not a person, not because the value is missing.
    [
      'TOTAL',
      '',
      String(summary.volume.resolved),
      ...durationCells(summary.firstResponse),
      ...durationCells(summary.resolution),
    ],
  ];
}

function agentRow(row: AgentReportRow): readonly string[] {
  return [
    row.name ?? UNATTRIBUTED_LABEL,
    String(row.isActive),
    String(row.ticketsResolved),
    ...durationCells(row.firstResponse),
    ...durationCells(row.resolution),
  ];
}

function seriesRows(response: DashboardMetricsResponse): readonly (readonly string[])[] {
  return [
    ['date', 'created', 'resolved', 'first_response_median_seconds'],
    ...response.series.map((point) => [
      point.date,
      String(point.created),
      String(point.resolved),
      seconds(point.firstResponseMedianSeconds),
    ]),
  ];
}

function durationHeaders(prefix: string): readonly string[] {
  return [
    `${prefix}_count`,
    `${prefix}_average_seconds`,
    `${prefix}_median_seconds`,
    `${prefix}_p90_seconds`,
  ];
}

function durationCells(stats: DurationStats): readonly string[] {
  return [
    String(stats.count),
    seconds(stats.averageSeconds),
    seconds(stats.medianSeconds),
    seconds(stats.p90Seconds),
  ];
}

function seconds(value: number | null): string {
  return value === null ? '' : String(value);
}

/** RFC 4180: CRLF between records, and a quoted field wherever one is needed. */
function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(escapeField).join(',')).join('\r\n');
}

/**
 * A field whose first character is `=`, `+`, `-`, `@`, a tab or a carriage return
 * is prefixed with an apostrophe before quoting: agent names are tenant-supplied
 * text, and a CSV is opened in a spreadsheet by definition.
 */
function escapeField(value: string): string {
  const neutralised = FORMULA_LEAD.test(value) ? `'${value}` : value;

  return NEEDS_QUOTING.test(neutralised) ? `"${neutralised.replaceAll('"', '""')}"` : neutralised;
}

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /["\r\n,]/;
