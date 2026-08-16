/**
 * The two numbers the reporting read is tuned by, named here so neither is a
 * literal buried in a statement.
 */

/**
 * How long a report's transaction may spend in the database before Postgres
 * cancels it.
 *
 * Tighter than the pool-wide 30 s `prisma-client.factory.ts` sets, and
 * deliberately so: that ceiling exists to stop one runaway statement holding a
 * connection open, and it is generous precisely *because* reporting is the
 * legitimately slow caller. This is the reporting-specific bound — a report that
 * takes ten seconds is already a capacity problem the escalation in ADR 0010
 * decision 3 exists for, and holding a connection for three times that while a
 * supervisor stares at a spinner helps nobody.
 *
 * A statement cancelled here surfaces as `internal_error` with the `requestId`,
 * per 0010's error table: the range is already capped, so there is nothing the
 * caller could ask differently to fix it.
 */
export const REPORT_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * The percentiles the dashboard publishes.
 *
 * A median survives one outlier and a mean does not, which is the whole reason
 * `percentile_cont` is worth the rows it needs. p90 is the "how bad is the tail"
 * number a supervisor actually acts on. Both are an assumption rather than a
 * stated client requirement (0010 risk 7); adding p95 is an additive contract
 * field and one more line of SQL.
 */
export const REPORT_PERCENTILES = { median: 0.5, p90: 0.9 } as const;
