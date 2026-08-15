import { Injectable } from '@nestjs/common';
import type { PlanLimits } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { PlanLimitExceededError } from './entitlements.errors';
import { UsageCounterService } from './usage-counter.service';

/**
 * The tenant's effective plan limits, and the write-time checks that enforce
 * them (TAR-405, against 0009 decision 6).
 *
 * ## Where the numbers come from, and why that matters
 *
 * `tenant_entitlements` — one row per tenant, RLS-scoped, written by provisioning
 * and by TAR-37's plan sync when it lands. **Nothing here is hardcoded**, which
 * is the acceptance criterion: swapping the trial placeholder for real Polar.sh
 * plan data is an update to that row, not a code change and not an API change.
 *
 * 0009 decision 6 put the limits in `plans.entitlements` instead. TAR-403
 * shipped this table and recorded why it diverged — `plans` belongs to TAR-37,
 * is platform-wide and so carries no RLS policy, and would require a
 * `subscriptions` row per tenant before any tenant could be capped. This service
 * reads what actually landed. The shape a caller sees is the same either way, so
 * if the two are reconciled later it is this file that moves and not its callers.
 *
 * ## `null` is unlimited, and so is a missing row
 *
 * `null` is the column's own encoding of "no ceiling" — deliberately not `-1` or
 * a sentinel maximum, both of which invite arithmetic bugs at the comparison
 * site.
 *
 * A tenant with **no row at all** is also unlimited, and that is a decision
 * rather than an oversight. TAR-403's migration grandfathered every existing
 * tenant onto an explicit `unlimited` row precisely because they were
 * provisioned by an operator and never sold a cap; `TenantProvisioningService`
 * still writes no row, so an operator-provisioned tenant created after that
 * migration has none. Failing closed there would make the admin route start
 * refusing invites for tenants nobody ever capped. The cap is a billing ceiling,
 * not a security boundary — tenant isolation is RLS's job and is unaffected
 * either way — so the open default is the correct failure direction. Self-signup
 * writes the row inside its provisioning transaction, so a trial tenant is never
 * in this case.
 *
 * ## Why the check takes a lock
 *
 * A seat check is read-then-write, and two invitations landing together would
 * both read "2 of 3" and both insert. 0009 calls creation the place the admin
 * finds out and acceptance the guarantee; a guarantee two concurrent acceptances
 * can step over is not one. So every seat-consuming write serialises on a
 * transaction-scoped advisory lock keyed by tenant, the same mechanism
 * `TenantProvisioningService` uses on a slug. It is released by the commit or
 * the rollback, so a crashed request cannot leave it held, and the contention it
 * creates is per tenant on a path that runs at human speed.
 *
 * ## Why the conversation cap takes no lock
 *
 * The one place not to copy the seat check. Seats is a *level*, and two
 * concurrent acceptances that both read "2 of 3" step over a guarantee — hence
 * the lock. Conversation volume is a monotonic counter against a ceiling that
 * gates and warns and never bills, so an overshoot of a handful under
 * concurrency costs nothing and a reconcile pass corrects it. Serialising every
 * tenant's sends on one advisory lock, on the highest-volume path in the
 * product, to protect a non-billing ceiling is the wrong trade.
 */
@Injectable()
export class PlanLimitsService {
  constructor(private readonly usage: UsageCounterService) {}
  /**
   * Refuses the caller if the tenant has no seat left for one more member.
   *
   * Call it **inside** the transaction that consumes the seat and pass that
   * transaction's client: the lock, the count and the insert have to be one
   * atomic unit, and a check made before the transaction opens would be a read
   * of a number that can change before the write lands.
   */
  async assertSeatAvailable(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
    const row = await tx.tenantEntitlements.findFirst({ select: { entitlements: true } });
    const cap = limitOf(row?.entitlements, 'seats');

    if (cap === null) {
      return;
    }

    // Only once a cap is known to exist. An unlimited tenant pays no lock and no
    // count for a ceiling it does not have.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SEAT_LOCK_PREFIX + tenantId}))`;

    const used = await countSeatsHeld(tx);

    if (used >= cap) {
      throw PlanLimitExceededError.seats(cap, used);
    }
  }

  /**
   * Refuses the caller when the tenant has opened its plan's allowance of
   * conversations in the current period.
   *
   * Called from the **outbound send**, never from ingest. That asymmetry is the
   * design and not an oversight: a conversation is opened by a customer writing
   * in, so metering counts inbound-opened threads, but refusing the inbound
   * write to enforce a quota would lose a real person's message to fix a billing
   * problem. What the cap withholds is the reply.
   *
   * No lock — see the note on the class. Takes the caller's transaction so the
   * count it reads is the one its own increment would land against.
   */
  async assertConversationVolumeAvailable(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<void> {
    const row = await tx.tenantEntitlements.findFirst({ select: { entitlements: true } });
    const cap = limitOf(row?.entitlements, 'conversationsPerPeriod');

    if (cap === null) {
      return;
    }

    const { value } = await this.usage.current(tx, {
      tenantId,
      metric: 'conversations_opened',
    });

    if (value >= cap) {
      throw PlanLimitExceededError.conversationsPerPeriod(cap, value);
    }
  }
}

/**
 * Namespaced so the hash cannot collide with a lock some other feature takes on
 * the same tenant id.
 */
const SEAT_LOCK_PREFIX = 'plan-limits:seats:';

/**
 * One ceiling out of `tenant_entitlements.entitlements`, which is
 * `PlanEntitlementsSchema`'s shape (ADR 0009 Amendment 1 ruling 3 — the column
 * replaced the per-limit columns, so enforcement and display read one row).
 *
 * **Null means unlimited, and so does anything unreadable.** A missing row, a
 * missing key or a value that is not a positive integer all return null, which
 * is the fail-open branch both callers document: a billing ceiling that refuses
 * work because a JSON blob surprised it is worse than one that lets a tenant
 * over the line until somebody notices. The database is not relying on this to
 * be careful — `tenant_entitlements_shape` refuses every one of those shapes at
 * write time — so in practice this narrowing is unreachable, and it exists so
 * that a hand-edited row cannot lock a tenant out.
 *
 * Keyed rather than one reader per limit: `PlanLimitsSchema` has five, three of
 * them still unenforced, and five copies of this narrowing is five places for
 * one of them to disagree about what "unlimited" looks like.
 */
function limitOf(entitlements: unknown, name: keyof PlanLimits): number | null {
  if (typeof entitlements !== 'object' || entitlements === null) {
    return null;
  }

  const { limits } = entitlements as { limits?: unknown };

  if (typeof limits !== 'object' || limits === null) {
    return null;
  }

  const value = (limits as Record<string, unknown>)[name];

  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * A seat is held by a member who occupies one, plus every invitation still
 * outstanding.
 *
 * **Two counts rather than one**, because they are two different populations and
 * folding them into a single scan of `users` would be wrong. An `invited` user
 * row survives its invitation being revoked — `InviteService.revoke` leaves it
 * alone on purpose, because withdrawing a link is not removing an account — so
 * counting `users.status = 'invited'` would charge the tenant for every
 * invitation it ever cancelled and eventually lock the admin out of inviting
 * anyone.
 *
 * The member half is exactly `occupiesSeat` in `people.mapper.ts`: `active` or
 * `suspended`, never `invited` and never `removed`. A suspended member still
 * holds their seat, because releasing it on suspension would let a tenant park
 * staff to dodge the cap — that rule is already published on
 * `UserResponse.occupiesSeat`, and this is the enforcement that makes it mean
 * something.
 *
 * That is a deliberate widening of 0009 decision 6, which says "`users` where
 * `status = 'active'`, plus `invites` still pending". Counting only `active`
 * would contradict the `occupiesSeat` contract that shipped first, and would
 * reopen the parking loophole its comment describes.
 *
 * Sequential rather than concurrent: both statements run inside one interactive
 * transaction on one connection, so there is nothing to win by issuing them
 * together and a clearer read to lose.
 */
async function countSeatsHeld(tx: Prisma.TransactionClient): Promise<number> {
  const members = await tx.user.count({ where: { status: { in: ['active', 'suspended'] } } });
  // Live invitations only: an accepted one has already become a member and would
  // otherwise be counted twice, and a revoked or lapsed one is a seat the tenant
  // got back.
  //
  // The same predicate `statusFilter('pending')` uses in `invite.service.ts`,
  // restated rather than imported: identity depends on this module and importing
  // back would close the cycle. If one of the two changes, the other is wrong —
  // `plan-limits.service.spec.ts` pins the shape from this side.
  const pending = await tx.invite.count({
    where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
  });

  return members + pending;
}
