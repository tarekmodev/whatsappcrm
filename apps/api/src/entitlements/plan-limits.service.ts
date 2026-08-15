import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PlanLimitExceededError } from './entitlements.errors';

/**
 * The tenant's effective plan limits, and the write-time checks that enforce
 * them (TAR-405, against 0009 decision 6).
 *
 * ## Where the numbers come from, and why that matters
 *
 * `tenant_plan_limits` — one row per tenant, RLS-scoped, written by provisioning
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
 * ## What is not here
 *
 * `tenant_plan_limits.conversation_cap` has no check yet. 0009 puts its
 * enforcement at the outbound send, "once the counter is over", against a
 * `conversations_opened` usage counter — and nothing on `main` writes
 * `usage_counters` outside the demo seed, so the comparison would be against a
 * permanent zero. Shipping that would be enforcement that reads as working and
 * never refuses, which is worse than its absence. The counter needs a writer and
 * a period anchor first; both are recorded on TAR-405.
 */
@Injectable()
export class PlanLimitsService {
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
    const cap = seatCapOf(row?.entitlements);

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
}

/**
 * Namespaced so the hash cannot collide with a lock some other feature takes on
 * the same tenant id.
 */
const SEAT_LOCK_PREFIX = 'plan-limits:seats:';

/**
 * The seat ceiling out of `tenant_entitlements.entitlements`, which is
 * `PlanEntitlementsSchema`'s shape (ADR 0009 Amendment 1 ruling 3 — the column
 * replaced `seat_cap`, so enforcement and display read one row).
 *
 * **Null means unlimited, and so does anything unreadable.** A missing row, a
 * missing key or a value that is not a positive integer all return null, which
 * is the fail-open branch `assertSeatAvailable` documents: a billing ceiling
 * that refuses work because a JSON blob surprised it is worse than one that
 * lets a tenant over the line until somebody notices. The database is not
 * relying on this to be careful — `tenant_entitlements_shape` refuses every one
 * of those shapes at write time — so in practice this narrowing is unreachable
 * and exists so that a hand-edited row cannot lock a tenant out.
 */
function seatCapOf(entitlements: unknown): number | null {
  if (typeof entitlements !== 'object' || entitlements === null) {
    return null;
  }

  const { limits } = entitlements as { limits?: unknown };

  if (typeof limits !== 'object' || limits === null) {
    return null;
  }

  const { seats } = limits as { seats?: unknown };

  return typeof seats === 'number' && Number.isInteger(seats) && seats > 0 ? seats : null;
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
