import { Injectable } from '@nestjs/common';
import type { UsageMetric } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { uuidV7 } from '../prisma/uuid-v7';
import { UsagePeriodResolver, type UsagePeriod } from './usage-period.resolver';

/**
 * Writes and reads `usage_counters` (TAR-405).
 *
 * **A partial implementation, deliberately.** `usage.ts` publishes a
 * `UsageService` port with `increment`, `recordGauge`, `current`, `summary` and
 * `reconcile`; this class implements the two that conversation-volume
 * enforcement needs and does not claim the token. `recordGauge` belongs with
 * seat billing, and `summary` and `reconcile` belong with TAR-37, which owns the
 * nightly job and the usage panel. Binding a half-built class to `USAGE_SERVICE`
 * would let a later caller inject the port and find three methods missing.
 *
 * ## The correctness rule this exists to honour
 *
 * `usage.ts` states it: an increment must happen in the **same database
 * transaction** as the row that causes it. Meta replays webhook deliveries, and
 * a replay that hits the `provider_message_id` unique constraint rolls the
 * transaction back — taking the increment with it. Counting at the edge, in
 * Redis, would double-count on every retry, silently, in the one subsystem where
 * wrong numbers eventually become wrong invoices. So every method here takes the
 * caller's transaction client and none of them opens its own.
 */
@Injectable()
export class UsageCounterService {
  constructor(private readonly periods: UsagePeriodResolver) {}

  /**
   * Adds `by` to a metric for the period `at` falls in, and returns the value
   * the counter now holds.
   *
   * `period_end` is written on insert and **not** in the `DO UPDATE` set. It is
   * not part of the conflict key, so letting a later writer rewrite it would let
   * one revised anchor silently restate the bounds of a period already being
   * counted — history rewritten by an increment.
   *
   * ## Why it returns the new value
   *
   * So a caller can detect the exact increment that **crossed** a threshold, by
   * comparing `value - by` against `value`. That is what makes TAR-37's volume
   * warning once-per-period by construction rather than by a second table
   * remembering whether it has already been sent: the upsert takes a row lock,
   * so under concurrency exactly one transaction observes the crossing.
   *
   * The alternative — read the counter, compare, then write — is two statements
   * with a race between them, and the race sends the warning twice or not at
   * all.
   */
  async increment(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; metric: UsageMetric; by?: number; at?: Date },
  ): Promise<number> {
    const at = input.at ?? new Date();
    const period = await this.periods.resolve(tx, input.tenantId, at);

    const [row] = await tx.$queryRaw<{ value: bigint }[]>`
      INSERT INTO usage_counters (id, tenant_id, metric, period_start, period_end, value, updated_at)
      VALUES (
        ${uuidV7()}::uuid,
        ${input.tenantId}::uuid,
        ${input.metric},
        ${period.start},
        ${period.end},
        ${input.by ?? 1}::bigint,
        now()
      )
      ON CONFLICT (tenant_id, metric, period_start)
      DO UPDATE SET value      = usage_counters.value + EXCLUDED.value,
                    updated_at = now()
      RETURNING value
    `;

    // `RETURNING` on an upsert always yields the row it touched, so this is
    // unreachable — and a clear zero beats a `TypeError` two frames later in a
    // path that runs inside the inbound-message transaction.
    return Number(row?.value ?? 0n);
  }

  /**
   * The metric's value in the current period, for a quota check on the request
   * path. Absent row reads as zero — nothing has happened yet this period.
   *
   * Returns the period alongside the value: the caller that refuses a write
   * wants to say which window it was refused against, and resolving it twice
   * would be two round trips for one answer.
   */
  async current(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; metric: UsageMetric; at?: Date },
  ): Promise<{ value: number; period: UsagePeriod }> {
    const period = await this.periods.resolve(tx, input.tenantId, input.at ?? new Date());

    const counter = await tx.usageCounter.findFirst({
      where: { metric: input.metric, periodStart: period.start },
      select: { value: true },
    });

    // `BigInt` because a long-lived tenant's message count outgrows `int4`. A
    // conversation count that reached `Number.MAX_SAFE_INTEGER` would be a
    // different problem entirely, so narrowing here is safe and keeps the
    // comparison at the call site ordinary arithmetic.
    return { value: Number(counter?.value ?? 0n), period };
  }
}
