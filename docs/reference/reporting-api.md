# Reporting dashboard and export

The supervisor performance dashboard and the CSV that has to agree with it:
`GET /api/v1/reports/dashboard` and `GET /api/v1/reports/dashboard/export`. Written for
engineers building against the API or operating the platform.

A **metric** is one aggregate over the tickets in a range. The **range** is two tenant-local
calendar dates. **Scope** is which tickets the caller may aggregate over. **Attribution** is
which agent a ticket's response or resolution is counted against. **Parity** is the property
that the CSV and the JSON carry the same numbers for the same query.

The supervisor's version of this page — what each figure means on screen, and how to export
it — is [Read the performance dashboard](../guides/read-the-performance-dashboard.md).

Request and response shapes are defined in `packages/contracts/src/reporting.ts` and
validated at the boundary. The implementation lives in `apps/api/src/reporting/`. The
behaviour below is ruled by
[0010 — Reporting dashboard and export](../architecture/0010-reporting-dashboard-and-export.md).
Every request and response on this page was executed against a local stack; see
[Verification](#verification).

## Conventions

| Concern           | Rule                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Base path         | `/api/v1`                                                                                                                   |
| Tenant            | Resolved from the request `Host`, never from a body, header or query parameter                                              |
| Parameters        | Query string only. Both routes are `GET` and neither takes a body                                                           |
| Timestamps        | ISO 8601 with an explicit offset                                                                                            |
| Durations         | Integer seconds, or `null`. Never a formatted string — see [Durations](#durations-are-integer-seconds-and-null-is-not-zero) |
| Dates             | `YYYY-MM-DD`, interpreted in the tenant's timezone                                                                          |
| Error shape       | The standard envelope, with a code from `packages/contracts/src/error-codes.ts`                                             |
| Lists             | Not paginated. The response is bounded by agent count and the range cap                                                     |
| `Idempotency-Key` | Not used. Both routes are safe and idempotent — nothing is written                                                          |

## Authentication and permissions

Both routes require a signed-in user presenting the session cookie `wac_session`
(`__Host-wac_session` wherever `SESSION_COOKIE_SECURE` is on).

| Route                                  | Permission    | Held by    |
| -------------------------------------- | ------------- | ---------- |
| `GET /api/v1/reports/dashboard`        | `report:read` | every role |
| `GET /api/v1/reports/dashboard/export` | `report:read` | every role |

This surface **adds no permission and moves no grant**. `report:read` and `report:read_all`
already existed in [the RBAC matrix](../architecture/0004-rbac-permission-matrix.md).

**`report:read_all` is deliberately not on either route.** It widens what a caller sees
rather than deciding whether they may call at all, so an agent opening a supervisor's
dashboard link gets a valid dashboard covering their own visible set instead of a `403`.
That is ADR 0004 invariant 2 — narrow, never reject — and it is why a `403` from these
routes is not reachable through any seeded role. The response echoes the scope it actually
used, which is what stops a narrowed view reading as data loss.

| Role       | Holds                           | Gets                                                  |
| ---------- | ------------------------------- | ----------------------------------------------------- |
| agent      | `report:read`                   | Their own and their teams' tickets; one breakdown row |
| supervisor | `report:read` `report:read_all` | The whole tenant; a row per agent                     |
| admin      | `report:read` `report:read_all` | The whole tenant; a row per agent                     |

## `GET /api/v1/reports/dashboard`

Response time, resolution time, ticket volume and the per-agent breakdown, over a
tenant-local date range.

**Authentication.** Session cookie, `report:read`. Absent or invalid answers `401`
`unauthenticated`.

**Idempotency.** Safe. Nothing is written, so a replay is free. The numbers can change
between two calls only because the underlying tickets did.

| Parameter        | In    | Type                | Required | Default | Notes                                                        |
| ---------------- | ----- | ------------------- | -------- | ------- | ------------------------------------------------------------ |
| `from`           | query | `YYYY-MM-DD`        | yes      | —       | Tenant-local date, inclusive. The API applies no default     |
| `to`             | query | `YYYY-MM-DD`        | yes      | —       | Tenant-local date, inclusive                                 |
| `scope`          | query | `assigned` \| `all` | no       | `all`   | Narrowed to `assigned` without `report:read_all`             |
| `assignedTeamId` | query | uuid                | no       | —       | Restricts to tickets assigned to that team. `404` if unknown |

**`from` and `to` are required and the API applies no default.** A range this layer invented
would be a period nobody asked for, carried into an export and quoted to a client with
nothing on the response saying where it came from. Choosing a starting range is a
presentation decision, so it belongs to the caller: the console picks the last 30 days,
fills its own date fields from that choice and names the resolved range above the figures.
The API's contribution is that the range is always explicit in the request and echoed in
`range`.

```bash
curl -b cookies.txt \
  'https://northwind.app.example.com/api/v1/reports/dashboard?from=2026-08-01&to=2026-08-16'
```

```json
{
  "range": {
    "from": "2026-08-01",
    "to": "2026-08-16",
    "timezone": "Europe/London",
    "startsAt": "2026-07-31T23:00:00.000Z",
    "endsAt": "2026-08-16T23:00:00.000Z"
  },
  "scope": "all",
  "summary": {
    "volume": { "created": 3, "resolved": 1, "closedWithoutResolution": 0 },
    "firstResponse": {
      "count": 2,
      "averageSeconds": 1290,
      "medianSeconds": 1290,
      "p90Seconds": 2082
    },
    "resolution": { "count": 1, "averageSeconds": 3900, "medianSeconds": 3900, "p90Seconds": 3900 }
  },
  "agents": [
    {
      "userId": "0192f001-0000-7000-8000-000000000101",
      "name": "Amina Haddad",
      "isActive": true,
      "ticketsResolved": 0,
      "firstResponse": {
        "count": 1,
        "averageSeconds": 300,
        "medianSeconds": 300,
        "p90Seconds": 300
      },
      "resolution": {
        "count": 0,
        "averageSeconds": null,
        "medianSeconds": null,
        "p90Seconds": null
      }
    },
    {
      "userId": "0192f001-0000-7000-8000-000000000102",
      "name": "Priya Raman",
      "isActive": true,
      "ticketsResolved": 1,
      "firstResponse": {
        "count": 1,
        "averageSeconds": 2280,
        "medianSeconds": 2280,
        "p90Seconds": 2280
      },
      "resolution": {
        "count": 1,
        "averageSeconds": 3900,
        "medianSeconds": 3900,
        "p90Seconds": 3900
      }
    }
  ],
  "series": [
    { "date": "2026-08-01", "created": 0, "resolved": 0, "firstResponseMedianSeconds": null },
    { "date": "2026-08-10", "created": 1, "resolved": 1, "firstResponseMedianSeconds": 2280 },
    { "date": "2026-08-16", "created": 1, "resolved": 0, "firstResponseMedianSeconds": 300 }
  ]
}
```

The `agents` and `series` arrays are abridged above; the real response carries every active
agent and every day in the range.

| Status | Code                | Cause                                                                                       |
| ------ | ------------------- | ------------------------------------------------------------------------------------------- |
| `200`  | —                   |                                                                                             |
| `400`  | `validation_failed` | `from` after `to`; a range over 366 days; a malformed date; a `from` or `to` that is absent |
| `401`  | `unauthenticated`   | No session                                                                                  |
| `403`  | `forbidden`         | The tenant is deactivated with a session still open                                         |
| `404`  | `not_found`         | `assignedTeamId` names no team this tenant has                                              |
| `500`  | `internal_error`    | The report exceeded its 10 s statement timeout                                              |

**An unknown `assignedTeamId` is `404`, not an empty dashboard.** A filter that matches
nothing would return a valid-looking page of zeroes, which is indistinguishable from a quiet
week. The lookup runs under row-level security (RLS), so another tenant's team id is not
found rather than refused — a `403` would confirm the id names something real.

**A timed-out report is `500`, deliberately.** The range is already capped, so there is
nothing the caller can ask differently; it is a capacity fault on the platform's side. The
detail is in the log line with its `requestId`.

> **TODO(author):** `validation_failed` on these routes carries the message "The request body
> failed validation." even though both routes read only the query string. Harmless but
> misleading in a client that surfaces the message; raised as a defect rather than fixed here.

## `GET /api/v1/reports/dashboard/export`

The same numbers as CSV bytes.

**Authentication.** Session cookie, `report:read`. Identical to the JSON route.

**Idempotency.** Safe. Nothing is written.

Every parameter of the JSON route, plus one:

| Parameter | In    | Type                              | Required | Default  | Notes                             |
| --------- | ----- | --------------------------------- | -------- | -------- | --------------------------------- |
| `section` | query | `summary` \| `agents` \| `series` | no       | `agents` | Chooses the file, not the numbers |

`section` selects a serialiser and never reaches a statement.

```bash
curl -b cookies.txt -OJ \
  'https://northwind.app.example.com/api/v1/reports/dashboard/export?from=2026-08-01&to=2026-08-16'
```

```text
HTTP/1.1 200 OK
content-type: text/csv; charset=utf-8
content-length: 620
content-disposition: attachment; filename="report-agents-2026-08-01-2026-08-16.csv"
x-content-type-options: nosniff
cache-control: private, no-store
```

```text
row,user_id,name,is_active,tickets_resolved,first_response_count,first_response_average_seconds,first_response_median_seconds,first_response_p90_seconds,resolution_count,resolution_average_seconds,resolution_median_seconds,resolution_p90_seconds
agent,0192f001-0000-7000-8000-000000000101,Amina Haddad,true,0,1,300,300,300,0,,,
agent,0192f001-0000-7000-8000-000000000102,Priya Raman,true,1,1,2280,2280,2280,1,3900,3900,3900
total,,,,1,2,1290,1290,2082,1,3900,3900,3900
```

The error table is the JSON route's, plus `validation_failed` for a `section` outside the
three values.

### The bytes

| Property          | Value                                                           | Why                                                                                                                      |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Encoding          | UTF-8 **with a byte-order mark**                                | Excel on Windows reads a BOM-less UTF-8 CSV as the local code page, and agent names in this product are routinely Arabic |
| Line endings      | `\r\n`                                                          | RFC 4180 §2.1                                                                                                            |
| Quoting           | RFC 4180, applied only where a field needs it                   | Also applied to surrounding whitespace, which is otherwise invisible in a diff                                           |
| Durations         | Integer seconds                                                 | A spreadsheet can compute on `8040` and cannot compute on `"2h 14m"`                                                     |
| Nulls             | An empty field                                                  | A spreadsheet ignores an empty cell in an average, which is the correct arithmetic                                       |
| Formula injection | A field beginning `=`, `+`, `-`, `@`, tab or CR is prefixed `'` | A CSV is opened in a spreadsheet by definition, and agent names are tenant-supplied text                                 |
| File name         | `report-<section>-<from>-<to>.csv`                              | Four exports in a morning are four distinguishable files, and the folder sorts usefully                                  |

Nothing in the file name needs sanitising: `section` is an enum and both dates are parsed
before a handler sees them, so every character comes from `[a-z0-9-]`. An assertion in
`report-export-file-name.ts` keeps that true if a future filter is ever spliced in.

### The three sections

| Section   | One row per                      | Ends with                         |
| --------- | -------------------------------- | --------------------------------- |
| `summary` | The whole range                  | —                                 |
| `agents`  | Agent, plus the unattributed row | A `TOTAL` row that is the summary |
| `series`  | Tenant-local day in the range    | —                                 |

One section per file rather than several tables stacked with blank lines between them, which
no spreadsheet imports cleanly.

**The `agents` file's last row is `total`, and it is the summary — never a sum of the rows
above it.** A median does not compose, so the total's `first_response_median_seconds` is not
the median of that column and must not be presented as though it were. The `row` column is
what distinguishes it: an agent may legitimately be named `TOTAL`, and a file whose last row
is identifiable only by a display name is one rename away from being misread.

## Parity: why the file and the screen agree

TAR-30's second acceptance criterion — exported data matches what is on screen — is
structural here, not maintained.

`ReportingQueryService.dashboard()` is the only method in the system that aggregates ticket
metrics. **Both routes call it, and there is no SQL on the export path**: the CSV route hands
the result to a serialiser that touches no database and takes no query parameters. Four
properties follow, and each is a way the numbers could otherwise drift:

1. **One filter parse.** Both routes validate against schemas built from the same object
   shape in `packages/contracts/src/reporting.ts`, so the range the export used and the range
   the screen shows are the same parsed value rather than two readings of one query string.
2. **One rounding.** Durations are rounded to integer seconds in SQL, once. Nothing rounds
   again at format time.
3. **One aggregation set.** The tenant total and the per-agent rows come from a single
   statement using `GROUPING SETS`, so the summary cannot disagree with the breakdown even
   inside one response.
4. **One visibility predicate.** `report-scope.ts` builds it, reading its values out of
   `assignedFilter` — the same function `TicketQueryService` passes to Prisma.

`dashboard-export-parity.spec.ts` asserts it end to end: the CSV, parsed back, carries the
values the JSON body carries for the same query string. That test guards a property the
structure already has rather than being the only thing holding it up.

If a future change needs a value the JSON does not carry, add it to
`DashboardMetricsResponse` so both surfaces get it. Reaching for Prisma from the serialiser
would reintroduce exactly the drift this design prevents.

**An asynchronous report-generation service was rejected**, and the reason is worth knowing
before anyone proposes it again: a job runs _later_, so even sharing a query layer it is
produced against a database that has moved on from the screen the supervisor was looking at.
It would be correct and still not match. The triggers to revisit are a row-level per-ticket
export, or scheduled reports delivered without a browser waiting.

## The four metrics

### Each metric is anchored on the event that makes it true

A date range has to be applied to a column, and the four metrics do not share one.

| Metric                     | Anchored on                        | Value                            | Attributed to             |
| -------------------------- | ---------------------------------- | -------------------------------- | ------------------------- |
| Volume — created           | `created_at`                       | count                            | — (a customer created it) |
| Volume — resolved          | `resolved_at`                      | count                            | `resolved_by_user_id`     |
| Volume — closed unresolved | `closed_at`, `resolved_at IS NULL` | count                            | —                         |
| First response time        | `first_response_at`                | `first_response_at - created_at` | `first_response_user_id`  |
| Resolution time            | `resolved_at`                      | `resolved_at - created_at`       | `resolved_by_user_id`     |

Anchoring everything on `created_at` instead would not be reproducible: a ticket created on
the last day of a range and resolved a week later would change that range's resolution time
after the fact, so a report exported on Monday and re-exported on Friday would disagree with
itself for reasons nobody could see.

**Two consequences worth stating rather than discovering.** A single range can count one
ticket in more than one bucket, or in none — a ticket created in January and resolved in
March appears in January's `created` and March's `resolved`. That is the point: `created`
measures arriving work and `resolved` measures completed work, and showing both tells a
supervisor whether the team is keeping up. And the totals do not reconcile row by row:
`created` and `resolved` in the same range are counts over different ticket sets.

### Durations are integer seconds, and null is not zero

Each duration metric publishes `count`, `averageSeconds`, `medianSeconds` and `p90Seconds`.
The three durations are **`null` exactly when `count` is zero**, never `0`, because "no
ticket was answered" and "every ticket was answered instantly" are different facts. The
contract enforces the correspondence with a refinement, so a response cannot carry one
without the other.

`count` is the sample size the statistic was computed over. It matters: a p90 over two
tickets _is_ one of those two tickets, and the duration alone does not say so.

**Durations are wall-clock, including nights and weekends.** A ticket arriving at 17:30 shows
a 15-hour response time that says nothing about the team, and a client-facing report inherits
that. This is the same open risk ADR 0006 raised for SLA windows and it is unresolved for
both. Business-hours reporting would need a holiday calendar and timezone arithmetic, not a
flag, and is its own story.

> **TODO(author):** ADR 0010 risk 7 asks the PO to confirm p50/p90 are the intended
> definition before documentation states them as such. That confirmation has not happened.
> The figures below are what ships; adding p95 is an additive contract field and one line of
> SQL.

### The daily series

One point per tenant-local day, **zero-filled** — every day in the range is present, so a day
with no activity is a zero rather than a gap the caller has to reconstruct. Each point
carries `created`, `resolved` and `firstResponseMedianSeconds` (null where nothing was
answered that day).

## The range

`from` and `to` are tenant-local calendar dates, inclusive at both ends, interpreted in
`tenant_settings.timezone` and converted server-side to the half-open instant interval
`[from 00:00, to+1 day 00:00)`. The response echoes both the resolved instants and the zone
that produced them.

The same two dates therefore resolve differently per tenant, which is the point:

| Tenant    | `tenant_settings.timezone` | `from=2026-08-01` resolves to |
| --------- | -------------------------- | ----------------------------- |
| northwind | `Europe/London`            | `2026-07-31T23:00:00.000Z`    |
| southwind | `America/New_York`         | `2026-08-01T04:00:00.000Z`    |

**The zone is the server's decision, not the client's.** Letting a caller send instants would
make the export, a scheduled report and a support engineer with `curl` each responsible for
knowing the tenant's zone and agreeing on it, with no way for the server to check that they
did. The conversion happens in SQL so the range endpoints and the daily buckets are computed
by one engine with one set of DST rules inside one transaction.

**The range is capped at 366 days** (`REPORT_RANGE_MAX_DAYS`), refused with
`validation_failed` before any SQL runs. A 366-day range is accepted; 367 is not. The cap
bounds the one query whose row count the caller chooses, and lets "a year" through.

Two edges, recorded rather than handled:

- **A local midnight that does not exist.** In a zone that shifts at midnight, Postgres
  resolves the missing instant forward. That moves a boundary by an hour once a year.
- **Changing a tenant's timezone re-buckets history.** A report run before and after a zone
  change can differ at day boundaries. Accepted: the alternative is a stored report entity,
  which v1 has none of (ADR 0010 risk 6).

**A tenant with no `tenant_settings` row falls back to UTC** and logs a warning once per
request. It is a provisioning gap rather than a caller error, and it is visible in the
response because `range.timezone` echoes what was actually used.

## Scope and attribution

### Scope decides which tickets are counted

`scope=all` covers the tenant; `scope=assigned` covers the caller's own and their teams'
tickets. A caller without `report:read_all` asking for `all` is **narrowed to `assigned`
rather than refused**, and the response echoes `"scope": "assigned"` so the console can say
so beside the numbers.

Without `report:read_all` the `agents` array additionally contains **one row, the caller's
own — plus the unattributed row where there is one**. ADR 0004 invariant 4 fixes which
tickets are aggregated, and `scope` already applies it; what is withheld is the breakout by
colleague, because an agent's visible set includes their team's tickets and a per-agent table
over it is a ranking of their teammates. The summary and series are unchanged and still cover
the visible set. This narrows and can never widen, so it cannot become a read channel around
the matrix.

**Do not assert `agents.length === 1` for a narrowed caller.** The unattributed row is
appended independently of the permission, so an agent whose visible set contains work with no
recorded responder or resolver receives two rows.

**The row count is decided by the permission, not by `scope`.** A caller holding
`report:read_all` gets a row per active user whichever `scope` they ask for; the rows their
narrowed set has no work for come back zero-filled rather than absent.

> **TODO(author):** ADR 0010 open question 1 leaves this as a product call for the PO. It
> ships as described; it is one branch in one service to reverse.

### Attribution is recorded history, not current assignment

The per-agent breakdown groups by `tickets.first_response_user_id` and
`tickets.resolved_by_user_id` — written by the writers that already establish those facts,
`SlaTimerService.stampFirstResponse` and the ticket command service.

Grouping by `assigned_user_id` was rejected because it rewrites history: a ticket reassigned
in March would move its January response time onto a different agent's row, so a closed
period's numbers would change after they were reported to a client.

**This creates an asymmetry that is correct and worth knowing.** Visibility reads _current_
assignment; attribution reads _recorded_ history. An agent's own first response on a ticket
that has since been reassigned away is excluded from their scoped report, because they cannot
see that ticket now — while a supervisor's tenant-wide report still counts it, on the original
responder's row.

### The roster, and the rows that are not agents

The breakdown carries **every active user, zero-filled**, not only those with work in the
range. The roster query selects on `status: 'active'` with no role predicate, so supervisors
and admins appear as rows too — "agent" in the field names is the loose sense, not the role.
Somebody who resolved nothing is a fact about the range, and their absence would read as a
loading bug. An _inactive_ user appears only when they have work in the range, so a departed
contractor's numbers do not vanish out of a closed period; `isActive` is `false` on their row.

A final row with `userId: null` and `name: null` is the **unattributed** row: work whose
responder or resolver was never recorded — a ticket predating the attribution columns, or a
resolution with no actor. It is rendered rather than hidden, because dropping it would leave a
table that does not add up to the summary above it with no explanation of the difference.

The backfill that populated those columns is best-effort and inherits ADR 0006 risk 3: a
reply sent on a second conversation for a multi-number tenant is invisible to it, and lands
unattributed.

## Tenant isolation

Every statement runs on `TenantPrisma` inside **one** `$tenantTransaction`, so the tenant GUC
is set once and RLS supplies the tenant equality on all six statements. There is no `tenantId`
parameter anywhere in the module.

The aggregates are hand-written SQL, which ADR 0002 decision 1 explicitly anticipated for
reporting. That is safe precisely because isolation is enforced by RLS rather than by the
query: a missing tenant yields zero rows, never every row. Every caller-supplied value is a
bound parameter; the only identifiers spliced into a statement are the four column-name
literals in `DURATION_ANCHORS`, reachable only through a key of a TypeScript union.

**This module adds no `SystemPrisma` call site**, so the written list in
[the tenant isolation contract](tenancy.md) is unchanged and there is no second tenant binding
point to review.

## Performance and operations

The aggregation is live over `tickets` — no rollup table and no materialised view. Zero
staleness is what makes parity trivially true, percentiles need the underlying rows because
medians do not compose across daily buckets, and a materialised view cannot carry an RLS
policy at all.

Four indexes on `tickets` serve it: `tickets_reporting_metrics_idx`
(`tenant_id, created_at, assigned_user_id, status, first_response_at, resolved_at`) plus a
range anchor each for `first_response_at`, `resolved_at` and `closed_at`. Without the anchors
those three scans cost what the tenant's whole history costs, whatever range was asked for.

The cost grows with the number of tickets in the range rather than the number of agents, so
it has a breaking point. `ReportingQueryService` logs the resolved range, the row counts and
the elapsed time on **every** request — counts and durations only, never a tenant's numbers
and never a name:

```text
Report served: 16 day(s), scope=all, 4 agent row(s), 16 series point(s), 12ms
```

A p95 that climbs with a tenant's history is the signal to start ADR 0010 decision 3's
escalation, and it will not announce itself any other way.

Each report transaction sets `SET LOCAL statement_timeout = 10000`, tighter than the pool-wide
30 s. Reporting is the legitimately slow caller, and holding a connection for thirty seconds
while a supervisor watches a spinner helps nobody.

**There is no caching.** The range is caller-chosen and the query is cheap; a cache would be a
staleness bug on the one surface whose entire acceptance criterion is that two views agree.

## Limits and known gaps

- **No pagination.** The response is bounded by the tenant's agent count and by the 366-day
  range cap, not by a growing table. A row-level per-ticket export would not have that
  property and is one of the two triggers for revisiting the synchronous design.
- **The CSV body is built in full before the first header goes out**, not streamed. Bounded by
  the same argument.
- **Durations are wall-clock.** See above; unresolved for reporting and SLA alike.
- **p50/p90 only.** No p95, no configurable percentile.
- **No scheduled or emailed reports.** Both would call this same query layer.
- **The backfill is best-effort.** Unattributed work is rendered, not hidden.

## Verification

Every request and response on this page was executed against a local stack from
`agent/technical-writer/tar-434-reporting-docs` at `036d9d3`: `docker compose up -d --wait`,
`pnpm db:migrate:deploy`, `pnpm db:roles`, `pnpm db:roles:login`, `node dist/seed/seed.js`,
then the built API on port `3051`. Ids, timestamps and durations are the values that run
returned. `pnpm exec jest src/reporting` passed: 7 suites, 87 tests.

⚠️ **The stack ran with `AUTH_STUB_ENABLED=true`** — the interim role stub driven by
`x-dev-role` — rather than with real session cookies, because seeded users carry no password
hash and this page needed a principal in each role. The stub resolves a real seeded user and
materialises its permissions from the real matrix, so what was exercised is the permission
model; what was **not** exercised is session issue and revocation. The `curl` samples above
are written with `-b cookies.txt`, which is how a real client authenticates.

Confirmed rather than assumed:

- **Parity holds on real data.** The `agents` CSV `total` row and the JSON `summary` were
  compared field by field and matched: `1,2,1290,1290,2082,1,3900,3900,3900`. Every per-agent
  row matched its JSON counterpart by name and `ticketsResolved`.
- **The BOM is present.** The first three bytes of every export are `EF BB BF`.
- **The response headers are exactly** `content-type: text/csv; charset=utf-8`,
  `content-disposition: attachment; filename="report-agents-2026-08-01-2026-08-16.csv"`,
  `x-content-type-options: nosniff`, `cache-control: private, no-store`, plus
  `content-length`.
- **An agent is narrowed, not refused.** Requesting `?scope=all` as an agent returned `200`
  with `"scope": "assigned"`, one row in `agents` (their own), and a summary over their
  visible set only — `created: 1` against the supervisor's `created: 3`.
- **Tenant isolation.** The same range against `southwind.app.localhost` returned that
  tenant's own zero counts in `America/New_York`, against northwind's three in
  `Europe/London`.
- **The range cap is 366 inclusive.** `2025-08-01`→`2026-08-01` returned `200`;
  `2025-08-01`→`2026-08-02` returned `400` "Range must not exceed 366 days".
- **`from` after `to`** returned `400` "`from` must not be after `to`".
- **An unknown `assignedTeamId`** returned `404 not_found`, not an empty dashboard.
- **An unknown `section`** returned `400` naming the three valid options.
- **An empty range returns nulls, not zeros.** `2026-01-01`→`2026-01-07` returned
  `count: 0` with all three durations `null`, seven zero-filled series points, and all four
  active agents present.
- **Formula injection is neutralised.** An agent renamed `=cmd|' /c calc'!A1` exported as
  `'=cmd|' /c calc'!A1` — prefixed, inert, and not truncated.
- **The unattributed row renders and the total still reconciles.** With
  `resolved_by_user_id` nulled, the `agents` file carried
  `unattributed,,,false,1,0,,,,1,3900,3900,3900` and the `total` row was unchanged.
- **The log line is emitted per request**, carrying only counts and durations.
