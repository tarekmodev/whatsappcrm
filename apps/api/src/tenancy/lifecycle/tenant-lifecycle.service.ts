import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BillingEvent, LifecycleTrigger, TenantStatus } from '@whatsappcrm/contracts';
import type { AuditActor } from '../../audit/audit-actor';
import type { Prisma } from '../../generated/prisma/client';
import { NOTIFY_TENANT_LIFECYCLE_JOB, TENANCY_QUEUE } from '../../queue/queue.constants';
import { QueueService } from '../../queue/queue.service';
import { SYSTEM_PRISMA, type SystemPrisma } from '../../prisma/prisma.tokens';
import { uuidV7 } from '../../prisma/uuid-v7';
import { TenantNotFoundError } from '../tenant-deactivation.errors';
import { InvalidTenantTransitionError } from './tenant-lifecycle.errors';
import { refuseTransition, timerColumnsFor } from './tenant-lifecycle.state';

/** Namespaced so the hash cannot collide with a lock another feature takes on the same tenant. */
const LIFECYCLE_LOCK_PREFIX = 'tenant-lifecycle:';

/** A lock, two reads and two writes. Generous for a busy database, short enough to give up. */
const TRANSACTION_TIMEOUT_MS = 10_000;

/** The lifecycle columns, and the only ones any of this reads. */
const LIFECYCLE_PROJECTION = {
  id: true,
  slug: true,
  name: true,
  status: true,
  trialEndsAt: true,
  gracePeriodEndsAt: true,
  suspendedAt: true,
  cancelledAt: true,
  purgeAt: true,
  purgeStartedAt: true,
  deletedAt: true,
} as const;

/** A tenant's lifecycle, as every writer and the operator surface see it. */
export interface TenantLifecycleState {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  trialEndsAt: Date | null;
  gracePeriodEndsAt: Date | null;
  suspendedAt: Date | null;
  cancelledAt: Date | null;
  purgeAt: Date | null;
  purgeStartedAt: Date | null;
  deletedAt: Date | null;
}

export interface TenantTransition {
  tenantId: string;
  to: TenantStatus;
  trigger: LifecycleTrigger;
  actor: AuditActor;
  /** Free text for the trail. Never rendered to the tenant, never a credential. */
  reason?: string;
  /** A `providerEventId` for a billing trigger, the elapsed timer for a timer. Never PII. */
  metadata?: Record<string, string>;
}

export interface TransitionResult {
  state: TenantLifecycleState;
  /** The `lifecycle_events` row this wrote, or null when the call was a no-op. */
  eventId: string | null;
  /** False when the tenant was already in `to` and nothing was written. */
  transitioned: boolean;
}

/**
 * Which status a normalised `BillingEvent` moves a tenant to (0009 decision 4,
 * `billing.ts`).
 *
 * `subscription.updated` is deliberately absent: a plan or seat change is
 * TAR-37's to apply to `tenant_entitlements`, and it moves no tenant between
 * lifecycle states. Mapping it to anything would make a routine upgrade a
 * lifecycle transition with an email attached.
 */
const BILLING_EVENT_TARGETS: Readonly<Partial<Record<BillingEvent['type'], TenantStatus>>> = {
  'subscription.activated': 'active',
  'payment.succeeded': 'active',
  'subscription.past_due': 'past_due',
  'payment.failed': 'past_due',
  'subscription.canceled': 'cancelled',
};

/**
 * **The only writer of `tenants.status`** (ADR 0009, the transition seam).
 *
 * One function, one transaction, one audit row. Everything that moves a tenant
 * between lifecycle states comes through `transition()`: the tenant admin
 * cancelling, the operator deactivating or reactivating, a billing webhook, and
 * the retention sweep. `TenantProvisioningService` is the single documented
 * exception, and only because its write happens inside the `INSERT` that creates
 * the row — there is no prior state to transition from.
 *
 * ## What one transition does
 *
 * Inside one `SystemPrisma` transaction, holding an advisory lock on the tenant:
 *
 *   1. reads the tenant's current lifecycle columns;
 *   2. refuses an edge the state machine does not have, or one this trigger may
 *      not cause;
 *   3. writes `status` and the timer columns arriving at — and leaving — a state
 *      implies;
 *   4. writes the `lifecycle_events` row, with the same database `now()`.
 *
 * Then, **after the commit**, it enqueues the notification. Not inside: a mailer
 * outage that rolled back a suspension would leave a tenant that should have
 * been locked out still running, which is the wrong failure. The queue is an
 * accelerator; the row with `notified_at IS NULL` is the truth, and the sweep is
 * the backstop that re-enqueues it (0009 decision 7).
 *
 * ## Idempotent on `(tenantId, to)`
 *
 * A tenant already in `to` returns its current state and writes nothing — no
 * second audit row, no second email, no re-stamped `suspended_at`. That is what
 * makes the sweep, a retried operator request and a replayed billing webhook all
 * safe to run twice. The advisory lock is what makes it true under concurrency:
 * two callers transitioning the same tenant at once serialise, and the second
 * one reads the state the first committed.
 *
 * ## Why `SystemPrisma`
 *
 * `tenants` carries no row-level security policy and `TenantPrisma` refuses to
 * write it outright — and could not do this work anyway, since half of these
 * transitions are about a tenant that is not serviceable. This is ADR 0009's
 * seventh permitted call site, and it consolidates rather than widens: it is the
 * same table provisioning and deactivation already write. Every statement here
 * names one tenant, by id.
 */
@Injectable()
export class TenantLifecycleService {
  private readonly logger = new Logger(TenantLifecycleService.name);

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly queue: QueueService,
  ) {}

  /**
   * Applies a transition, or throws `InvalidTenantTransitionError`.
   *
   * Throws `TenantNotFoundError` for an id no tenant carries — the same answer a
   * mistyped slug gets from deactivation, and for the same reason: silently
   * succeeding would let an operator believe a tenant that is still serving
   * traffic had been stopped.
   */
  async transition(input: TenantTransition): Promise<TransitionResult> {
    const result = await this.systemPrisma.$transaction(
      async (tx) => await applyTransition(tx, input),
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    if (!result.transitioned) {
      this.logger.log(
        `Tenant ${result.state.slug} (${result.state.id}) is already ${input.to}; nothing written.`,
      );

      return result;
    }

    this.logger.log(
      `Tenant ${result.state.slug} (${result.state.id}) → ${input.to} ` +
        `(trigger ${input.trigger}, actor ${input.actor.actorType}).`,
    );

    await this.enqueueNotification(result);

    return result;
  }

  /**
   * The lifecycle columns as they stand. Reads nothing else — the plan and the
   * seat usage `TenantLifecycleResponse` also carries live on the tenant
   * connection and are assembled by `TenantLifecycleReader`.
   */
  async state(tenantId: string): Promise<TenantLifecycleState> {
    const tenant = await this.systemPrisma.tenant.findUnique({
      where: { id: tenantId },
      select: LIFECYCLE_PROJECTION,
    });

    if (tenant === null) {
      throw new TenantNotFoundError(tenantId);
    }

    return tenant;
  }

  /**
   * Consumes a normalised `BillingEvent` — TAR-37's entry point, published and
   * implemented now against the union `billing.ts` already fixed.
   *
   * That is the seam that keeps a provider out of lifecycle logic, and it is
   * testable today by constructing the union directly, which is how the tests
   * here reach `past_due` with no provider in existence.
   *
   * **An event that names an illegal edge is a no-op, not a failure.** A webhook
   * consumer that threw would make the provider retry an event that will never
   * be applicable — `payment.failed` arriving for a tenant an operator cancelled
   * an hour ago is late news, not an error. It is logged and the current state is
   * returned.
   */
  async applyBillingEvent(event: BillingEvent): Promise<TransitionResult> {
    const to = BILLING_EVENT_TARGETS[event.type];

    if (to === undefined) {
      // `subscription.updated`: a plan or seat change, which TAR-37 applies to
      // `tenant_entitlements` and which moves no tenant between states.
      return { state: await this.state(event.tenantId), eventId: null, transitioned: false };
    }

    try {
      return await this.transition({
        tenantId: event.tenantId,
        to,
        trigger: 'billing_event',
        actor: { actorType: 'system', actorUserId: null, actorLabel: null },
        // The provider's own event id and nothing else. Never a payment
        // instrument, never a token, never a customer record.
        metadata: { providerEventId: event.providerEventId, billingEventType: event.type },
      });
    } catch (error: unknown) {
      if (!(error instanceof InvalidTenantTransitionError)) {
        throw error;
      }

      this.logger.warn(
        `Billing event ${event.type} (${event.providerEventId}) does not apply to tenant ` +
          `${event.tenantId}: ${error.message}`,
      );

      return { state: await this.state(event.tenantId), eventId: null, transitioned: false };
    }
  }

  /**
   * The notification, after the commit.
   *
   * The `lifecycle_events` row id **is** the job id, which is what makes a
   * redelivery a no-op: BullMQ ignores an `add` for an id it already holds. A
   * failure here is not a failure of the transition — `enqueue` never throws,
   * and the row still carries `notified_at IS NULL` for the sweep to find.
   */
  private async enqueueNotification({ state, eventId }: TransitionResult): Promise<void> {
    if (eventId === null) {
      return;
    }

    const outcome = await this.queue.enqueue(
      TENANCY_QUEUE,
      NOTIFY_TENANT_LIFECYCLE_JOB,
      { tenantId: state.id, eventId },
      { jobId: eventId },
    );

    if (outcome === 'added') {
      return;
    }

    this.logger.warn(
      `Could not queue the notification for lifecycle event ${eventId} (${outcome}); ` +
        'the lifecycle sweep will re-enqueue it.',
    );
  }
}

/**
 * The transaction body, as a free function so the sweep and the purge can reuse
 * it inside a transaction they already hold — a nested `$transaction` would
 * either deadlock on the advisory lock or silently run outside it.
 */
export async function applyTransition(
  tx: Prisma.TransactionClient,
  input: TenantTransition,
): Promise<TransitionResult> {
  // Serialises concurrent transitions of the same tenant. Transaction-scoped, so
  // a crashed caller cannot leave it held, and the read below therefore sees
  // whatever the previous holder committed rather than racing it.
  //
  // `hashtext` is an internal function whose result is not contractually stable
  // across major versions, which is acceptable for the same reason
  // `TenantDeactivationService` accepts it: a changed hash only means two callers
  // stop sharing a lock they contend for rarely.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LIFECYCLE_LOCK_PREFIX + input.tenantId}))`;

  const existing = await tx.tenant.findUnique({
    where: { id: input.tenantId },
    select: LIFECYCLE_PROJECTION,
  });

  if (existing === null) {
    throw new TenantNotFoundError(input.tenantId);
  }

  if (existing.status === input.to) {
    return { state: existing, eventId: null, transitioned: false };
  }

  const refusal = refuseTransition(existing.status, input.to, input.trigger);

  if (refusal !== null) {
    throw new InvalidTenantTransitionError(existing.status, input.to, input.trigger, refusal);
  }

  // The **database** clock, read once and shared by both rows. Two API instances
  // a few seconds apart would otherwise be able to order the trail
  // inconsistently with the tenant row it describes.
  const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;

  const state = await tx.tenant.update({
    where: { id: existing.id },
    data: { status: input.to, ...timerColumnsFor(existing.status, input.to, now) },
    select: LIFECYCLE_PROJECTION,
  });

  const eventId = uuidV7(now);

  await tx.lifecycleEvent.create({
    data: {
      id: eventId,
      tenantId: existing.id,
      occurredAt: now,
      fromState: existing.status,
      toState: input.to,
      trigger: input.trigger,
      // Spread rather than assembled field by field, so no call site can build a
      // combination `lifecycle_events_actor_attribution` rejects.
      ...input.actor,
      reason: input.reason ?? null,
      metadata: input.metadata ?? undefined,
    },
    select: { id: true },
  });

  return { state, eventId, transitioned: true };
}
