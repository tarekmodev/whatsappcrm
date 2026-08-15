import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

/** The half-open window `[start, end)` a usage counter is recorded against. */
export interface UsagePeriod {
  start: Date;
  end: Date;
}

/**
 * Which period a usage counter belongs to — the **only** place a period is
 * computed (TAR-405, the Architect's ruling on TAR-405).
 *
 * Two branches, in order:
 *
 *   1. A `subscriptions` row with both `current_period_start` and
 *      `current_period_end` set. That is the provider's own billing period, and
 *      deriving from it is what stops a counter straddling two invoices when a
 *      tenant upgrades mid-month.
 *   2. Otherwise the **anniversary-monthly** window on `tenants.created_at`.
 *
 * `usage.ts` has published branch 2 since TAR-39, but it says two different
 * things — "a calendar month anchored on `tenant.createdAt`" — and those are not
 * the same window. It is the anniversary window; a calendar month straddles for
 * the same reason it does for a subscription.
 *
 * ## Why the anchor is `created_at` and not `trial_ends_at`
 *
 * **The anchor has to be immutable.** ADR 0009 clears every forward-looking
 * column on the transition that leaves the state which set it, so
 * `trialing → active` nulls `trial_ends_at`. Every counter row written during
 * the trial would then have a `period_start` nothing can recompute, and
 * `period_start` is part of `@@unique([tenant_id, metric, period_start])` — so
 * moving it does not correct a row, it forks a second one and hands the tenant a
 * fresh allowance mid-period.
 *
 * A trial window also has no successor. A tenant does not stop existing at
 * `trial_ends_at`; it becomes `past_due` and then `suspended`, and under what
 * TAR-403 shipped it has no `subscriptions` row for any of that. A single
 * `[created_at, trial_ends_at)` window would leave 44+ serviceable days with no
 * period at all.
 *
 * ## Always recomputed from the anchor
 *
 * Never by advancing the previous period. Postgres clamps `Jan 31 + 1 month` to
 * Feb 28 and `Jan 31 + 2 months` back to Mar 31; recomputing from the anchor is
 * stable, whereas iterating drifts a tenant's boundary a day at a time and never
 * recovers.
 *
 * ## Why the arithmetic is in Postgres
 *
 * `age()` yields whole months directly and `created_at + (n || ' months')`
 * clamps month-ends correctly, in the column's own `timestamptz`. JavaScript's
 * `Date.setMonth` overflows instead: 31 January plus one month is 3 March, which
 * would put a tenant's boundary two days into the next period and quietly widen
 * every window that starts on a 29th, 30th or 31st.
 */
@Injectable()
export class UsagePeriodResolver {
  /**
   * The period `at` falls in for this tenant. Pass the transaction the caller is
   * already in, so the anchor read is inside it.
   */
  async resolve(
    tx: Prisma.TransactionClient,
    tenantId: string,
    at: Date = new Date(),
  ): Promise<UsagePeriod> {
    const [period] = await tx.$queryRaw<PeriodRow[]>`
      SELECT
        COALESCE(s.current_period_start, t.created_at + (m.n     || ' months')::interval)
          AS period_start,
        COALESCE(s.current_period_end,   t.created_at + (m.n + 1 || ' months')::interval)
          AS period_end
      FROM tenants t
      -- Whole months elapsed since the anchor. age() gives a calendar interval
      -- rather than a duration, which is what "how many anniversaries" needs:
      -- a day count would drift across months of different lengths.
      CROSS JOIN LATERAL (
        SELECT (
          EXTRACT(YEAR  FROM age(${at}::timestamptz, t.created_at)) * 12 +
          EXTRACT(MONTH FROM age(${at}::timestamptz, t.created_at))
        )::int AS n
      ) m
      -- Both bounds or neither: a half-populated subscription must not contribute
      -- one of its edges to a window whose other edge came from the anchor, which
      -- is what two independent COALESCEs would otherwise allow.
      LEFT JOIN subscriptions s
        ON  s.tenant_id            = t.id
        AND s.current_period_start IS NOT NULL
        AND s.current_period_end   IS NOT NULL
      WHERE t.id = ${tenantId}::uuid
    `;

    if (period === undefined) {
      // The tenant row is gone, or RLS hid it. Either way there is no anchor and
      // no honest window to invent — a caller metering against a guess would
      // write rows nothing can reconcile.
      throw new Error(`No usage period could be resolved for tenant ${tenantId}.`);
    }

    return { start: period.period_start, end: period.period_end };
  }
}

interface PeriodRow {
  period_start: Date;
  period_end: Date;
}
