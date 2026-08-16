import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../generated/prisma/client';
import { SYSTEM_PRISMA, type SystemPrisma } from '../../prisma/prisma.tokens';
import { DomainOwnershipChecker } from './domain-ownership.checker';

/**
 * How many *due* claims one sweep re-checks.
 *
 * Bounded, like the webhook sweep: each one is an outbound DNS query, and a
 * backlog after an outage must drain across several intervals rather than
 * arrive as one burst at somebody else's nameservers.
 *
 * Every row in the batch is one this sweep will actually query — `dueClauses`
 * keeps the backed-off ones out of it — so the bound is on work done rather than
 * on rows read.
 */
const SWEEP_BATCH_SIZE = 100;

/**
 * Backoff between automatic re-checks, indexed by attempts already made.
 *
 * A domain whose DNS is never going to appear is asked about less and less,
 * rather than every cycle for seven days. The last entry is the ceiling: past
 * the end of the table, a claim is checked at that interval until it expires.
 */
const RECHECK_BACKOFF_MS = [
  0,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
] as const;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

/** What one sweep did, for the log line and for the tests. */
export interface DomainSweepReport {
  readonly checked: number;
  readonly verified: number;
  readonly expired: number;
}

/**
 * The background half of custom-domain verification (TAR-29).
 *
 * Two jobs in one pass, and they are the two things nobody is watching for:
 *
 *   1. **Re-check pending claims.** This is what makes verification *arrive*
 *      without the tenant sitting on a settings screen clicking a button. DNS
 *      propagation is minutes to hours; a flow that only verifies on demand is
 *      one where the customer's experience is "it did not work, try again
 *      later".
 *   2. **Release lapsed claims.** A claim reserves a globally unique hostname.
 *      Without an expiry, one tenant typing a competitor's domain holds it
 *      forever. `DOMAIN_VERIFICATION_TTL_DAYS` after the claim, an unverified
 *      row is deleted and the hostname is free again.
 *
 * Reclaim latency is therefore one sweep interval: a tenant told `conflict` on a
 * hostname whose claim has just lapsed succeeds on retry within that window.
 * That is documented behaviour rather than a bug — deleting another tenant's row
 * inline, at claim time, would need `SystemPrisma` at a *request*-path call
 * site, which is exactly the widening ADR 0002 confines.
 *
 * ## Why `SystemPrisma`, and why the writes use it too
 *
 * The sweep has no tenant in scope — it is one query across the whole fleet's
 * pending claims — so `TenantPrisma` refuses it by construction. This is the
 * sweeper call site ADR 0002 already permits.
 *
 * TAR-416 says the reads are unscoped and the writes are per tenant under RLS.
 * The writes are unscoped here, and the divergence is deliberate: `TenantPrisma`
 * refuses every statement for a **deactivated** tenant (`assert_tenant_active`),
 * so an RLS-scoped expiry pass would silently skip suspended tenants and leave
 * their squatted hostnames locked away from everyone forever. Every write below
 * names a single primary key this job read out of its own work queue, so it
 * cannot reach a row it did not select.
 *
 * It is a BullMQ repeatable job rather than a `@Cron`, which is what stops it
 * running once per replica: BullMQ's scheduler is the distributed lock.
 */
@Injectable()
export class DomainVerificationSweeper {
  private readonly logger = new Logger(DomainVerificationSweeper.name);

  private readonly verificationTtlMs: number;

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly ownership: DomainOwnershipChecker,
    config: ConfigService,
  ) {
    this.verificationTtlMs =
      config.getOrThrow<number>('DOMAIN_VERIFICATION_TTL_DAYS') * MILLISECONDS_PER_DAY;
  }

  async sweep(now: Date = new Date()): Promise<DomainSweepReport> {
    const expired = await this.releaseLapsedClaims(now);
    const { checked, verified } = await this.recheckPendingClaims(now);

    if (checked > 0 || expired > 0) {
      // Only when it did something. A sweep that finds nothing is the normal
      // state — the partial index it reads is usually empty — and a line every
      // interval saying so is a line nobody reads.
      this.logger.log(
        `Domain sweep: re-checked ${checked}, verified ${verified}, released ${expired} lapsed claim(s)`,
      );
    }

    return { checked, verified, expired };
  }

  /**
   * Deletes unverified claims past the window.
   *
   * Ordered before the re-check pass so a claim that expires this cycle is
   * released rather than spending one more DNS query first.
   */
  private async releaseLapsedClaims(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.verificationTtlMs);

    const { count } = await this.systemPrisma.tenantDomain.deleteMany({
      where: {
        kind: 'custom',
        verifiedAt: null,
        verificationRequestedAt: { lt: cutoff },
      },
    });

    return count;
  }

  /**
   * Asks DNS about the claims whose next check is due.
   *
   * Sequential rather than concurrent: each iteration is an outbound query to a
   * nameserver the tenant nominated, and a batch fired in parallel is this
   * platform being used to burst traffic at somebody. The batch is small and the
   * job is off the request path, so there is nothing to win by hurrying it.
   */
  private async recheckPendingClaims(now: Date): Promise<{ checked: number; verified: number }> {
    const pending = await this.systemPrisma.tenantDomain.findMany({
      where: {
        kind: 'custom',
        verifiedAt: null,
        verificationRequestedAt: { not: null },
        // Due-ness is part of the query, and it has to be. Applied in JavaScript
        // after `take`, a backed-off row still occupied its slot in the batch:
        // once the fleet held `SWEEP_BATCH_SIZE` pending claims — twenty tenants
        // at `MAX_CUSTOM_DOMAINS_PER_TENANT`, and an abandoned claim lives for
        // the full TTL — every slot was held by a row at its six-hour ceiling
        // and a claim made today never entered the window. Background
        // verification stopped arriving for new customers, silently, with the
        // manual button as the only way through.
        OR: dueClauses(now),
      },
      select: {
        id: true,
        hostname: true,
        verificationToken: true,
        verificationAttempts: true,
        verificationLastCheckedAt: true,
      },
      // Least-recently-checked first, never-checked ahead of all of them: the
      // round robin the backoff table assumes. Oldest-claim-first would put the
      // same long-abandoned rows at the head of every batch, which is the
      // starvation above wearing a different hat.
      //
      // `tenant_domains_unverified` still serves the predicate; the sort is not
      // index-ordered, and that is accepted — the partial index holds only
      // unverified rows, so the set being sorted is the fleet's pending claims
      // and nothing else, on a job that runs off the request path.
      orderBy: { verificationLastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: SWEEP_BATCH_SIZE,
    });

    let checked = 0;
    let verified = 0;

    for (const row of pending) {
      if (row.verificationToken === null) {
        // `tenant_domains_custom_needs_token` makes this unreachable; the guard
        // is for a row written before that constraint existed.
        continue;
      }

      const outcome = await this.ownership.check(row.hostname, row.verificationToken);

      checked += 1;

      await this.systemPrisma.tenantDomain.update({
        where: { id: row.id },
        data: {
          verificationLastCheckedAt: now,
          verificationAttempts: { increment: 1 },
          verifiedAt: outcome.proved ? now : null,
          verificationFailureReason: outcome.proved ? null : outcome.reason,
        },
      });

      if (outcome.proved) {
        verified += 1;
        // Worth a line each: this is the moment a white-label hostname starts
        // resolving, and it is also the moment the domain joins the operator's
        // activation queue.
        this.logger.log(`${row.hostname} verified by the sweep; awaiting activation at the edge`);
      }
    }

    return { checked, verified };
  }
}

/**
 * `RECHECK_BACKOFF_MS` as a `where`: which claims have waited out their backoff.
 *
 * The wait depends on the row's own `verification_attempts`, so this cannot be
 * one comparison — but the table has six entries, so it is six, plus the
 * never-checked case, which no `lte` would match against a null column. The last
 * entry is the ceiling and therefore matches `>=` rather than a single count.
 */
function dueClauses(now: Date): Prisma.TenantDomainWhereInput[] {
  const ceiling = RECHECK_BACKOFF_MS.length - 1;

  return [
    { verificationLastCheckedAt: null },
    ...RECHECK_BACKOFF_MS.map((wait, attempts) => ({
      verificationAttempts: attempts === ceiling ? { gte: attempts } : attempts,
      verificationLastCheckedAt: { lte: new Date(now.getTime() - wait) },
    })),
  ];
}
