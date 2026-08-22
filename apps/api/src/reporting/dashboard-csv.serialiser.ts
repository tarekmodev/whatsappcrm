import type {
  AgentReportRow,
  DailyPoint,
  DashboardMetricsResponse,
  DurationStats,
  ReportExportSection,
} from '@whatsappcrm/contracts';

/**
 * `DashboardMetricsResponse` → CSV bytes — TAR-430, ADR 0010 (reporting dashboard
 * and export) decision 7.
 *
 * **This module touches no database and takes no query parameters.** That is
 * the property the whole export design rests on: the export is a second
 * *serialisation* of one result, never a second computation. Give it the object
 * the dashboard route returns and it prints the numbers that object carries —
 * there is no rounding, no re-aggregation and no filtering here, so there is
 * nowhere for the file and the screen to disagree.
 *
 * If a future change needs a value the JSON does not carry, the answer is to
 * add it to `DashboardMetricsResponse` so both surfaces get it. Reaching for
 * Prisma from this file would reintroduce exactly the drift TAR-30's second
 * acceptance criterion exists to prevent.
 *
 * ## Four properties of the bytes, and why each one is there
 *
 *   * **UTF-8 with a byte-order mark.** Not decoration: Excel on Windows reads
 *     a BOM-less UTF-8 CSV as the local code page, and agent names in this
 *     product are routinely Arabic. Without it a supervisor opens a file full
 *     of mojibake and reports it as a data bug.
 *   * **RFC 4180 quoting and `\r\n` line endings**, which is what the RFC
 *     specifies and what every spreadsheet imports without a dialogue.
 *   * **Formula injection is neutralised on every text field**, not only on
 *     names. A CSV is opened in a spreadsheet by definition, and a field
 *     beginning `=`, `+`, `-`, `@`, a tab or a carriage return is a formula to
 *     Excel and to Sheets. Numeric fields are exempt because they cannot begin
 *     with one of those characters — every duration and count in the contract
 *     is a non-negative integer.
 *   * **Integer seconds, never a formatted duration.** A spreadsheet can
 *     compute on `8040` and cannot compute on `"2h 14m"`, and formatting stays
 *     in exactly one place: the console.
 *
 * ## Null is an empty field, and that is a decision
 *
 * `DurationStatsSchema` makes the durations null exactly when `count` is zero,
 * because "no ticket was answered" and "every ticket was answered instantly"
 * are different facts. Writing `0` here would collapse them, and a supervisor
 * charting the column would see a week of perfect response times where in fact
 * nothing was answered. An empty cell is what a spreadsheet ignores in an
 * average, which is the correct arithmetic.
 */

/**
 * The BOM, spelled as an escape rather than as a literal character: written
 * literally it is invisible in every editor and diff, and a file that quietly
 * loses it produces mojibake in Excel with nothing in the diff to explain it.
 */
const BYTE_ORDER_MARK = '\uFEFF';

/** RFC 4180 §2.1: CRLF, regardless of the platform the process runs on. */
const LINE_ENDING = '\r\n';

const FIELD_SEPARATOR = ',';

/**
 * The leading characters a spreadsheet treats as the start of a formula. The
 * tab and carriage return are in the list because Excel strips them before
 * deciding, so `\t=cmd` is a formula to it and an ordinary string to a naive
 * check.
 */
const FORMULA_LEAD_CHARACTERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * What the `row` column of the `agents` section says about the row it starts.
 *
 * A discriminator column rather than a bare `TOTAL` in the name field, which is
 * what 0010 describes: an agent may legitimately be called `TOTAL`, and a file
 * whose last row is only distinguishable by a display name is one rename away
 * from being misread by whatever consumes it. It also gives the unattributed
 * row a name — 0010 requires it to be rendered rather than hidden, and a row
 * with no id and no name is otherwise indistinguishable from a blank line.
 */
const AGENT_ROW_KINDS = {
  agent: 'agent',
  unattributed: 'unattributed',
  total: 'total',
} as const;

const SUMMARY_HEADER = [
  'from',
  'to',
  'timezone',
  'scope',
  'tickets_created',
  'tickets_resolved',
  'tickets_closed_without_resolution',
  ...durationHeader('first_response'),
  ...durationHeader('resolution'),
];

const AGENTS_HEADER = [
  'row',
  'user_id',
  'name',
  'is_active',
  'tickets_resolved',
  ...durationHeader('first_response'),
  ...durationHeader('resolution'),
];

const SERIES_HEADER = ['date', 'created', 'resolved', 'first_response_median_seconds'];

/**
 * The CSV for one section of one dashboard result.
 *
 * `section` selects a code path and never reaches a statement — it is an enum
 * from the contract, validated at the route, so there is no way for it to be
 * text that means something to a query.
 */
export function serialiseDashboardCsv(
  metrics: DashboardMetricsResponse,
  section: ReportExportSection,
): Buffer {
  const rows = sectionRows(metrics, section);
  const body = rows.map((row) => row.join(FIELD_SEPARATOR)).join(LINE_ENDING);

  return Buffer.from(`${BYTE_ORDER_MARK}${body}${LINE_ENDING}`, 'utf8');
}

function sectionRows(metrics: DashboardMetricsResponse, section: ReportExportSection): string[][] {
  switch (section) {
    case 'summary':
      return [SUMMARY_HEADER, summaryRow(metrics)];
    case 'agents':
      return [AGENTS_HEADER, ...metrics.agents.map(agentRow), totalRow(metrics)];
    case 'series':
      return [SERIES_HEADER, ...metrics.series.map(seriesRow)];
  }
}

function summaryRow(metrics: DashboardMetricsResponse): string[] {
  const { range, summary } = metrics;

  return [
    text(range.from),
    text(range.to),
    text(range.timezone),
    text(metrics.scope),
    count(summary.volume.created),
    count(summary.volume.resolved),
    count(summary.volume.closedWithoutResolution),
    ...durationCells(summary.firstResponse),
    ...durationCells(summary.resolution),
  ];
}

function agentRow(agent: AgentReportRow): string[] {
  const kind = agent.userId === null ? AGENT_ROW_KINDS.unattributed : AGENT_ROW_KINDS.agent;

  return [
    text(kind),
    text(agent.userId),
    text(agent.name),
    flag(agent.isActive),
    count(agent.ticketsResolved),
    ...durationCells(agent.firstResponse),
    ...durationCells(agent.resolution),
  ];
}

/**
 * The last row of the `agents` file: the summary, in the same columns.
 *
 * This is what makes "the export matches the screen" true of the headline
 * numbers in the file a supervisor actually downloads, rather than only of a
 * section they would have to ask for separately.
 *
 * It is taken from `summary`, **never** recomputed by summing the rows above
 * it, and the difference is not pedantry: a median does not compose, so the
 * total's `first_response_median_seconds` is not the median of the column and
 * must not be presented as though it were. `is_active` is empty because the
 * total is not a person.
 */
function totalRow(metrics: DashboardMetricsResponse): string[] {
  const { summary } = metrics;

  return [
    text(AGENT_ROW_KINDS.total),
    text(null),
    text(null),
    flag(null),
    count(summary.volume.resolved),
    ...durationCells(summary.firstResponse),
    ...durationCells(summary.resolution),
  ];
}

function seriesRow(point: DailyPoint): string[] {
  return [
    text(point.date),
    count(point.created),
    count(point.resolved),
    count(point.firstResponseMedianSeconds),
  ];
}

function durationHeader(prefix: string): string[] {
  return [
    `${prefix}_count`,
    `${prefix}_average_seconds`,
    `${prefix}_median_seconds`,
    `${prefix}_p90_seconds`,
  ];
}

function durationCells(stats: DurationStats): string[] {
  return [
    count(stats.count),
    count(stats.averageSeconds),
    count(stats.medianSeconds),
    count(stats.p90Seconds),
  ];
}

/**
 * A number, or an empty field for null.
 *
 * No quoting and no formula prefix: every number in the contract is a
 * non-negative integer, so none of them can begin with a character a
 * spreadsheet reads as a formula, and quoting them would make a spreadsheet
 * import the column as text.
 */
function count(value: number | null): string {
  return value === null ? '' : String(value);
}

/** `true` / `false`, or an empty field where the flag does not apply. */
function flag(value: boolean | null): string {
  return value === null ? '' : String(value);
}

/**
 * A text field: neutralised against formula injection, then quoted per RFC
 * 4180.
 *
 * The order matters. Prefixing after quoting would put the quote character
 * first and leave the formula intact.
 */
function text(value: string | null): string {
  if (value === null) {
    return '';
  }

  return quote(neutraliseFormula(value));
}

/**
 * Prefixes a single quote, which is the convention every spreadsheet reads as
 * "the rest of this cell is literal text".
 *
 * Applied to the whole value rather than by stripping the offending character:
 * a contact called `+9715…` is a real name and dropping the `+` would corrupt
 * it, where the prefix leaves it readable and inert.
 */
function neutraliseFormula(value: string): string {
  const lead = value.charAt(0);

  return FORMULA_LEAD_CHARACTERS.includes(lead) ? `'${value}` : value;
}

/**
 * RFC 4180 §2.6/§2.7 quoting, applied only where the field needs it.
 *
 * Surrounding whitespace is quoted too, though the RFC does not require it: an
 * unquoted trailing space is invisible in every viewer and is the sort of thing
 * that turns a diff of two exports into a puzzle.
 */
function quote(value: string): string {
  const needsQuoting =
    value.includes(FIELD_SEPARATOR) ||
    value.includes('"') ||
    value.includes('\r') ||
    value.includes('\n') ||
    value.trim() !== value;

  return needsQuoting ? `"${value.replaceAll('"', '""')}"` : value;
}
