import { Inject, Injectable, Logger } from '@nestjs/common';
import { PlanEntitlementsSchema, type BillingEvent } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import { uuidV7 } from '../prisma/uuid-v7';

/** Namespaced so the hash cannot collide with a lock another feature takes on the same tenant. */
const BILLING_LOCK_PREFIX = 'billing:subscription:';

/** A lock, three reads and three writes. Generous for a busy database, short enough to give up. */
const TRANSACTION_TIMEOUT_MS = 10_000;

/** What one `apply` did, so the caller knows whether to drive the lifecycle after it. */
export type SubscriptionSyncOutcome =
  /** Written. The caller applies the lifecycle transition after the commit. */
  | { readonly result: 'applied'; readonly planKey: string | null; readonly seats: number }
  /**
   * The event is older than the last one that wrote this row, so nothing was
   * written and nothing should move. Still marked processed.
   */
  | { readonly result: 'stale' }
  /**
   * The event names a plan this platform does not carry and there is no existing
   * subscription to fall back on, so there is no row that could be written.
   * Parked for an operator rather than retried.
   */
  | { readonly result: 'unresolved_plan'; readonly detail: string };

/**
 * **The only writer of `subscriptions` and of `tenant_entitlements` from a
 * billing event**, and the transaction that makes "the plan's limits take effect
 * immediately" true (TAR-37's first acceptance criterion).
 *
 * ## One transaction, three writes, one lock
 *
 * Inside one `SystemPrisma` transaction, holding an advisory lock on the tenant:
 *
 *   1. read the current `subscriptions` row and its `last_event_at`;
 *   2. **drop an event older than that row** — see below;
 *   3. write `subscriptions`: status, seats, period bounds, cancellation
 *      columns, `past_due_since`, provider ids, and `last_event_at`;
 *   4. copy the plan's entitlements into `tenant_entitlements`, with the plan
 *      key and name beside them.
 *
 * The copy is step 4 of the billing contract's decision 4, and it is what makes
 * `tenant_entitlements` unambiguously the *enforcement* truth and `plans`
 * unambiguously the catalogue. `PlanLimitsService` reads one RLS-scoped row on
 * the tenant connection; without the copy every seat check would have to join an
 * unscoped `plans` through `subscriptions`, on the request path, and would fail
 * outright for the trialing tenants that have no subscription row at all.
 *
 * `plan_key` and `plan_name` are copied with the entitlements so
 * `TenantLifecycleResponse.plan` stays a one-row read with no join.
 *
 * ## Why an event older than `last_event_at` writes nothing
 *
 * Providers retry with backoff and do not guarantee ordering. A retried
 * `past_due` can land after a fresh `active` and walk a tenant backwards into
 * dunning it has already left — a lockout caused entirely by delivery order. So
 * the row remembers the provider timestamp of whatever last wrote it, and an
 * older event is recorded in `webhook_events` for forensics and applied to
 * nothing.
 *
 * It compares the **provider's** clock to the provider's clock. `updated_at` is
 * our write time and comparing the two would be comparing two clocks.
 *
 * ## Why the lifecycle transition happens after the commit, not inside
 *
 * `TenantLifecycleService.applyBillingEvent` opens its own transaction and
 * enqueues a notification keyed on the `lifecycle_events` row id. Running it
 * inside this one would enqueue a job that starts before its row is visible —
 * the same point `TenantLifecycleService.notifyOfEvent` makes about its own
 * caller. So this returns an outcome and the caller drives the lifecycle.
 *
 * ## Why `SystemPrisma`
 *
 * `subscriptions` and `tenant_entitlements` are RLS-scoped, and this runs from a
 * webhook worker where there is no session and often no serviceable tenant — a
 * `past_due` tenant is exactly the one whose subscription needs writing. Every
 * statement here names one tenant, by id, taken from the resolved event.
 */
@Injectable()
export class SubscriptionSyncService {
  private readonly logger = new Logger(SubscriptionSyncService.name);

  constructor(@Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma) {}

  async apply(event: BillingEvent): Promise<SubscriptionSyncOutcome> {
    return await this.systemPrisma.$transaction(
      async (tx) => await applySubscriptionEvent(tx, event, this.logger),
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }
}

async function applySubscriptionEvent(
  tx: Prisma.TransactionClient,
  event: BillingEvent,
  logger: Logger,
): Promise<SubscriptionSyncOutcome> {
  // Serialises concurrent applications for one tenant: a webhook and the
  // reconciliation job can land together, and the second must read what the
  // first committed rather than race it. Transaction-scoped, so a crashed
  // caller cannot leave it held.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BILLING_LOCK_PREFIX + event.tenantId}))`;

  const existing = await tx.subscription.findUnique({
    where: { tenantId: event.tenantId },
    select: {
      id: true,
      planId: true,
      seats: true,
      status: true,
      lastEventAt: true,
      pastDueSince: true,
      providerCustomerId: true,
      providerSubscriptionId: true,
    },
  });

  const occurredAt = new Date(event.occurredAt);

  if (existing?.lastEventAt != null && occurredAt < existing.lastEventAt) {
    logger.log(
      `Billing event ${event.providerEventId} (${event.type}) for tenant ${event.tenantId} is ` +
        `older than the last one applied; ignored.`,
    );

    return { result: 'stale' };
  }

  const plan = await resolvePlan(tx, event);
  // `subscriptions.plan_id` is `NOT NULL`, so one of the two has to supply it:
  // the plan this event names, or the one the row already points at. The
  // narrowing is a real check rather than an assertion, because the case it
  // covers is reachable — an event carrying a product id nobody has seeded.
  const planId = plan?.id ?? existing?.planId;

  if (planId === undefined) {
    // Nothing to write, and no retry invents a catalogue row. Parked with the
    // payload intact for whoever seeds the mapping.
    return {
      result: 'unresolved_plan',
      detail:
        event.providerProductId !== undefined
          ? `no plan carries provider_product_id ${event.providerProductId}`
          : `no plan with key ${event.planKey ?? '(none supplied)'}`,
    };
  }

  const seats = event.seats ?? existing?.seats ?? 1;

  await tx.subscription.upsert({
    where: { tenantId: event.tenantId },
    create: {
      id: uuidV7(),
      tenantId: event.tenantId,
      planId,
      seats,
      ...providerColumns(event),
      ...periodColumns(event),
      ...cancellationColumns(event),
      status: event.status ?? 'active',
      pastDueSince: pastDueSince(event, null),
      lastEventAt: occurredAt,
    },
    update: {
      planId,
      seats,
      ...providerColumns(event),
      ...periodColumns(event),
      ...cancellationColumns(event),
      // A status the event does not carry leaves the column alone: a renewal
      // receipt that said nothing about status must not reset one.
      ...(event.status === null ? {} : { status: event.status }),
      pastDueSince: pastDueSince(event, existing?.pastDueSince ?? null),
      lastEventAt: occurredAt,
    },
  });

  if (plan !== null) {
    await copyEntitlements(tx, event.tenantId, plan, logger);
  }

  return { result: 'applied', planKey: plan?.key ?? null, seats };
}

/**
 * The catalogue row this event is about: by provider product id first, then by
 * plan key.
 *
 * Two branches because two kinds of provider exist. Polar knows a product uuid
 * and nothing about `planKey`, so `plans.provider_product_id` is the mapping —
 * that column is the whole reason it exists. A provider that speaks in plan keys
 * (and `FakeBillingProvider`, which does) resolves by key instead. An event that
 * names neither says nothing new about the plan, and the caller keeps whatever
 * the subscription already points at.
 *
 * `isActive` is deliberately **not** filtered on. A tier withdrawn from sale is
 * still honoured for the tenants already on it — that is what `is_active` and
 * `is_public` mean — and refusing to resolve it would strip a paying customer's
 * entitlements the day the plan was retired.
 */
async function resolvePlan(
  tx: Prisma.TransactionClient,
  event: BillingEvent,
): Promise<PlanRow | null> {
  if (event.providerProductId !== undefined) {
    const byProduct = await tx.plan.findFirst({
      where: { providerProductId: event.providerProductId },
      select: PLAN_PROJECTION,
    });

    if (byProduct !== null) {
      return byProduct;
    }
  }

  if (event.planKey !== null) {
    return await tx.plan.findUnique({
      where: { key: event.planKey },
      select: PLAN_PROJECTION,
    });
  }

  return null;
}

/**
 * Copies a plan's entitlements onto the tenant. **The write that makes a new
 * plan's limits take effect immediately.**
 *
 * Validated against `PlanEntitlementsSchema` first, and skipped if it does not
 * parse. `plans_entitlements_shape` refuses a malformed catalogue row at its own
 * write, so this is unreachable in practice — and it is here because the
 * alternative failure is the worst one available: the destination carries
 * `tenant_entitlements_shape`, so a malformed copy aborts the transaction, which
 * means a tenant that has *paid* and whose activation then fails, with the
 * webhook retrying into the same failure until Polar disables the endpoint.
 * Leaving the previous entitlements in place and shouting is strictly better
 * than that.
 *
 * `updateMany` rather than `update`: a tenant provisioned by an operator before
 * `tenant_entitlements` existed has no row, and a missing row must not fail a
 * paid activation. `PlanLimitsService` reads a missing row as unlimited, which
 * is the open direction — the tenant keeps working and the log says why.
 */
async function copyEntitlements(
  tx: Prisma.TransactionClient,
  tenantId: string,
  plan: PlanRow,
  logger: Logger,
): Promise<void> {
  const entitlements = PlanEntitlementsSchema.safeParse(plan.entitlements);

  if (!entitlements.success) {
    logger.error(
      `Plan ${plan.key} carries entitlements that are not PlanEntitlementsSchema, so tenant ` +
        `${tenantId} keeps the entitlements it had. Fix the catalogue row: ` +
        entitlements.error.message,
    );

    return;
  }

  const updated = await tx.tenantEntitlements.updateMany({
    where: { tenantId },
    data: {
      planKey: plan.key,
      planName: plan.name,
      entitlements: entitlements.data,
    },
  });

  if (updated.count === 0) {
    logger.warn(
      `Tenant ${tenantId} activated on plan ${plan.key} but has no tenant_entitlements row, so ` +
        'no ceiling is being enforced for it. Provision one.',
    );
  }
}

/**
 * `past_due_since` — set on the first report of a failed renewal, cleared when
 * the subscription is anything else.
 *
 * **Not the dunning clock.** The timer the lifecycle sweeper reads is
 * `tenants.grace_period_ends_at`, set by the transition this event goes on to
 * cause; this column is for support and reporting. Duplicating a deadline in two
 * columns is how the two drift apart.
 *
 * It keeps the *first* timestamp across repeated `past_due` reports, because the
 * question it answers is "how long has this been failing", and re-stamping it on
 * every retry would answer "when did we last hear about it".
 */
function pastDueSince(event: BillingEvent, current: Date | null): Date | null {
  if (event.status === 'past_due') {
    return current ?? new Date(event.occurredAt);
  }

  return event.status === null ? current : null;
}

/**
 * The period bounds, written only when the event carries both.
 *
 * Both or neither: `UsagePeriodResolver` joins `subscriptions` only when both
 * columns are set, precisely so a half-populated row cannot contribute one edge
 * of a window whose other edge came from the tenant's anniversary anchor.
 *
 * This is also what rolls a tenant's conversation allowance. Every event that
 * carries a subscription carries its current period, so a renewal advances the
 * bounds and `usage_counters` starts a fresh row against the new
 * `period_start` — without it a tenant's allowance would never reset.
 */
function periodColumns(event: BillingEvent): SubscriptionColumns {
  if (event.currentPeriodStart === null || event.currentPeriodEnd === null) {
    return {};
  }

  return {
    currentPeriodStart: new Date(event.currentPeriodStart),
    currentPeriodEnd: new Date(event.currentPeriodEnd),
  };
}

/**
 * The cancellation banner columns.
 *
 * `undefined` on the event means "this event says nothing about cancellation"
 * and leaves both columns alone; `false` means the cancellation was withdrawn
 * and clears them. Collapsing the two would make every routine update silently
 * un-cancel a subscription the customer asked to end.
 */
function cancellationColumns(event: BillingEvent): SubscriptionColumns {
  if (event.cancelAtPeriodEnd === undefined) {
    return {};
  }

  return {
    cancelAtPeriodEnd: event.cancelAtPeriodEnd,
    cancelsAt:
      event.cancelAtPeriodEnd && event.cancelsAt != null ? new Date(event.cancelsAt) : null,
  };
}

/** The provider's opaque ids, written only when the event names them. */
function providerColumns(event: BillingEvent): SubscriptionColumns {
  return {
    ...(event.providerSubscriptionId === undefined
      ? {}
      : { providerSubscriptionId: event.providerSubscriptionId }),
    ...(event.providerCustomerId === undefined
      ? {}
      : { providerCustomerId: event.providerCustomerId }),
  };
}

const PLAN_PROJECTION = {
  id: true,
  key: true,
  name: true,
  entitlements: true,
} as const;

interface PlanRow {
  id: string;
  key: string;
  name: string;
  entitlements: Prisma.JsonValue;
}

/**
 * The column fragments the upsert spreads into **both** its `create` and its
 * `update`.
 *
 * Typed as plain values rather than `Prisma.SubscriptionUncheckedUpdateInput`,
 * which also admits `{ set: … }` and `{ increment: … }` operation objects that a
 * `create` cannot take. Narrowing here is what lets one fragment serve both
 * halves; the alternative is two near-identical builders per column group.
 */
interface SubscriptionColumns {
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
  cancelsAt?: Date | null;
  providerSubscriptionId?: string;
  providerCustomerId?: string;
}
