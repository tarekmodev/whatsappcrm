import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PLAN_FEATURES,
  PlanEntitlementsSchema,
  type PlanEntitlements,
  type PlanLimits,
  type VolumePolicy,
} from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { PlanLimitExceededError } from './entitlements.errors';
import { UsageCounterService } from './usage-counter.service';

/**
 * The two populations that hold a seat, kept apart on the wire as well as in the
 * count — `TenantLifecycleResponse.usage` names both, so the console can render
 * "4 of 5, one invitation outstanding" rather than arithmetic the reader has to
 * do.
 */
export interface SeatUsage {
  /** Members whose status is `active` or `suspended`, per `occupiesSeat`. */
  seatsUsed: number;
  /** Invitations sent, not accepted, not revoked, not lapsed. */
  seatsPending: number;
}

export interface EffectiveEntitlements {
  key: string;
  name: string;
  entitlements: PlanEntitlements;
}

/**
 * What a tenant with no `tenant_entitlements` row reads as: every feature on,
 * every ceiling absent.
 *
 * It is the same shape `TenantProvisioningService` writes for an
 * operator-provisioned tenant, and it exists here for the rows written before
 * that did — a tenant nobody sold a cap has no cap, and the display has to say
 * so rather than render an empty panel.
 */
const UNCAPPED_ENTITLEMENTS: EffectiveEntitlements = {
  key: 'unlimited',
  name: 'Unlimited',
  entitlements: {
    features: [...PLAN_FEATURES],
    limits: {
      seats: null,
      conversationsPerPeriod: null,
      whatsappNumbers: null,
      teams: null,
      knowledgeDocuments: null,
    },
  },
};

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
  /**
   * `warn` or `block`, from `BILLING_VOLUME_POLICY`. Read once at construction:
   * it is deployment configuration, not a per-tenant setting, and re-reading it
   * per send would put a config lookup on the busiest path in the product.
   */
  private readonly volumePolicy: VolumePolicy;

  constructor(
    config: ConfigService,
    private readonly usage: UsageCounterService,
  ) {
    this.volumePolicy = config.getOrThrow<VolumePolicy>('BILLING_VOLUME_POLICY');
  }
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

    const { seatsUsed, seatsPending } = await this.seatUsage(tx);
    const used = seatsUsed + seatsPending;

    if (used >= cap) {
      throw PlanLimitExceededError.seats(cap, used);
    }
  }

  /**
   * The two halves of the seat count, for the caller that displays them as well
   * as the one that enforces against them.
   *
   * ADR 0009 Amendment 1 ruling 4 is explicit that this is **one** function:
   * `GET /tenant/lifecycle` calls it rather than re-deriving, so the console's
   * "3 of 3" and the refusal the admin just received cannot disagree. That
   * failure — a number from one store and a refusal from another — is what
   * "enforced, not merely displayed" exists to prevent, and two implementations
   * of the same count is the shape it takes.
   */
  async seatUsage(tx: Prisma.TransactionClient): Promise<SeatUsage> {
    return await countSeatsHeld(tx);
  }

  /**
   * The tenant's effective entitlements, as the console renders them.
   *
   * Read through the caller's transaction on the **tenant** connection, so the
   * row row-level security admits is the one this tenant was sold. A tenant with
   * no row at all reads as unlimited, for the reason the class comment gives at
   * length — a billing ceiling is not a security boundary, and failing closed
   * here would refuse work for tenants nobody ever capped.
   */
  async effectiveEntitlements(tx: Prisma.TransactionClient): Promise<EffectiveEntitlements> {
    const row = await tx.tenantEntitlements.findFirst({
      select: { planKey: true, planName: true, entitlements: true },
    });

    if (row === null) {
      return UNCAPPED_ENTITLEMENTS;
    }

    const parsed = PlanEntitlementsSchema.safeParse(row.entitlements);

    if (!parsed.success) {
      // Unreachable in practice — `tenant_entitlements_shape` refuses every
      // malformed shape at write time — and reported rather than thrown for the
      // same reason `limitOf` narrows silently: a hand-edited row must not be
      // able to take a tenant's settings screen down.
      return {
        key: row.planKey,
        name: row.planName,
        entitlements: UNCAPPED_ENTITLEMENTS.entitlements,
      };
    }

    return { key: row.planKey, name: row.planName, entitlements: parsed.data };
  }

  /**
   * Refuses the caller when the tenant has opened its plan's allowance of
   * conversations in the current period **and the configured policy is
   * `block`**.
   *
   * Called from the **outbound send**, never from ingest. That asymmetry is the
   * design and not an oversight: a conversation is opened by a customer writing
   * in, so metering counts inbound-opened threads, but refusing the inbound
   * write to enforce a quota would lose a real person's message to fix a billing
   * problem. What the cap withholds is the reply — and under `warn`, not even
   * that.
   *
   * ## The policy is configuration, not a code path
   *
   * `BILLING_VOLUME_POLICY` (TAR-37) selects it, and it defaults to `warn`
   * because blocking a helpdesk's replies is the most damaging thing this
   * system can do to a tenant's *customers*. Under `warn` the cap is still
   * metered and still crossed and still notified — the tenant and the reseller
   * both find out — and the send goes through. Inbound is never refused under
   * either policy.
   *
   * The check is skipped entirely under `warn`, rather than performed and its
   * result discarded: it is a counter read on the send path, and paying for it
   * to reach a branch that cannot refuse is waste on the product's busiest
   * route.
   *
   * No lock — see the note on the class. Takes the caller's transaction so the
   * count it reads is the one its own increment would land against.
   */
  async assertConversationVolumeAvailable(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<void> {
    if (this.volumePolicy !== 'block') {
      return;
    }

    const cap = await this.conversationCap(tx);

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

  /**
   * The tenant's conversation ceiling for the current period, or `null` when it
   * has none.
   *
   * Public because the **ingest** path needs it too, and for a different reason:
   * it refuses nothing, but it has to know whether an increment just crossed a
   * threshold worth telling the tenant admin about. One reader rather than two,
   * so the number the warning is measured against is the number the send path
   * would have refused on.
   */
  async conversationCap(tx: Prisma.TransactionClient): Promise<number | null> {
    const row = await tx.tenantEntitlements.findFirst({ select: { entitlements: true } });

    return limitOf(row?.entitlements, 'conversationsPerPeriod');
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
async function countSeatsHeld(tx: Prisma.TransactionClient): Promise<SeatUsage> {
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

  return { seatsUsed: members, seatsPending: pending };
}
