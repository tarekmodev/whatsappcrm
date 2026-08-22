import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BILLING_PROVIDER,
  type BillingEvent,
  type BillingProvider,
  type WebhookSubject,
} from '@whatsappcrm/contracts';
import { ErrorTrackingService } from '../observability/error-tracking.service';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import { TenantLifecycleService } from '../tenancy/lifecycle/tenant-lifecycle.service';
import { WebhookEventsRepository } from '../webhooks/webhook-events.repository';
import { BILLING_WEBHOOK_PROVIDER } from './billing.constants';
import { SeatSyncService } from './seat-sync.service';
import { SubscriptionSyncService } from './subscription-sync.service';

/**
 * Why a billing event was parked. Recorded in `webhook_events.last_error`, which
 * is what an operator greps during an incident, so each one names the fix.
 *
 * These are also the **grouping key of the alert** each park raises (TAR-668),
 * which is the second reason they are fixed tokens: the tracker files one issue
 * per reason, so "unresolved plan, forty times" is one thing to fix rather than
 * forty rows to read. Anything variable — a plan key, a parse detail, an id —
 * goes in the alert's context, never in the token.
 */
const PARK_REASON = {
  unresolvedTenant: 'unresolved_tenant',
  unrecognisedPayload: 'unrecognised_payload',
  unresolvedPlan: 'unresolved_plan',
  /**
   * The retry budget is spent on a fault that never settled. The token is what
   * makes this line groupable at all — the detail after it is the last error's
   * own message, which is different on every occurrence.
   */
  attemptsExhausted: 'attempts_exhausted',
} as const;

type ParkReason = (typeof PARK_REASON)[keyof typeof PARK_REASON];

/**
 * What a park alert can say about the delivery regardless of *why* it parked.
 *
 * Assembled once, immediately after the claim, because two of the four park
 * branches are reached before the payload has been parsed into anything — an
 * alert is only worth having if it can identify the delivery in every branch,
 * including the ones where nothing was understood.
 */
interface ParkedEvent {
  readonly webhookEventId: string;
  /** The provider's own event id — for Standard Webhooks, the `webhook-id` header. */
  readonly providerEventId: string;
  /** The provider's name for the event, when its envelope carried one. */
  readonly eventType: string | null;
}

/**
 * The worker half of the billing pipeline: take a stored `webhook_events` row,
 * resolve it to a tenant, and apply what it says.
 *
 * It runs against the durable row rather than against an HTTP request, which is
 * what makes every decision here retriable — and it mirrors
 * `WhatsAppEventProcessor` on purpose, down to the three outcomes:
 *
 *   * **processed** — applied, and the tenant recorded for forensics;
 *   * **parked `failed`** — something about the payload will never succeed on a
 *     retry. The row keeps its raw payload and stays queryable, so it can be
 *     replayed once the cause is fixed. Never dropped;
 *   * **rethrown** — a transient fault. BullMQ retries with backoff, and the
 *     sweeper is the backstop if the queue itself is the thing that failed.
 *
 * ## The order of the last two steps is load-bearing
 *
 * `SubscriptionSyncService.apply` commits first, and only then does
 * `TenantLifecycleService.applyBillingEvent` run. The lifecycle service opens
 * its own transaction and enqueues a notification keyed on the
 * `lifecycle_events` row id; running it inside the subscription transaction
 * would enqueue a job that starts before its row is visible. It is the same
 * point `notifyOfEvent` makes about its own caller.
 *
 * The consequence to know about: a crash between the two leaves the subscription
 * written and the tenant not yet moved. That is the safe direction — the row is
 * still `processing`, the sweeper re-enqueues it, and both writes are idempotent
 * on replay (`applyBillingEvent` is a no-op for a tenant already in the target
 * state, and the second `apply` is dropped by `last_event_at`).
 *
 * ## Dunning needs no code here
 *
 * `past_due → suspended` is a **timer**, owned by `TenantLifecycleSweeper`
 * against `tenants.grace_period_ends_at`. This processor writes the producer —
 * the `subscription.past_due` event that sets the clock — and nothing else. That
 * is what "via the lifecycle state machine, not an ad-hoc code path" means, and
 * it is why there is no suspension logic in this file to review.
 */
@Injectable()
export class BillingEventProcessor {
  private readonly logger = new Logger(BillingEventProcessor.name);
  private readonly maxAttempts: number;

  constructor(
    config: ConfigService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly events: WebhookEventsRepository,
    private readonly subscriptions: SubscriptionSyncService,
    private readonly seats: SeatSyncService,
    private readonly lifecycle: TenantLifecycleService,
    private readonly errorTracking: ErrorTrackingService,
  ) {
    this.maxAttempts = config.getOrThrow<number>('WEBHOOK_MAX_ATTEMPTS');
  }

  async process(webhookEventId: string): Promise<void> {
    const claimed = await this.events.claim(webhookEventId);

    if (claimed === null) {
      // Already `processed` or already parked `failed`. A provider retry, a
      // sweeper re-enqueue and an expired job lock all land here, and all three
      // cost one no-op UPDATE rather than a duplicated state change. **This is
      // the second layer of the replay defence**, under the unique constraint on
      // `(provider, provider_event_id)`.
      return;
    }

    const subject = this.provider.readWebhookSubject(claimed.payload);
    const parked: ParkedEvent = {
      webhookEventId,
      providerEventId: claimed.providerEventId,
      eventType: subject.eventType,
    };
    const tenantId = await this.resolveTenant(subject);

    if (tenantId === null) {
      // Recorded and parked, and the delivery was still answered 200. A 4xx or
      // 5xx would make the provider retry an event that will never resolve, and
      // ten of those disable the endpoint.
      await this.park(parked, PARK_REASON.unresolvedTenant, null);
      this.logger.warn(`Billing event ${webhookEventId} names no tenant we can resolve; parked.`);

      return;
    }

    // The worker runs off the stored row, not the HTTP request, so the original
    // headers are gone. `provider_event_id` **is** the `webhook-id` header —
    // that is why the ingest path keys idempotency on it — so handing it back to
    // the parser reconstructs the only header the parse actually needs.
    const parsed = this.provider.parseWebhookEvent(
      claimed.payload,
      { 'webhook-id': claimed.providerEventId },
      tenantId,
    );

    if (parsed.outcome === 'unreadable') {
      // Verified as genuinely the provider's, subscribed to, and still not
      // readable. No retry changes a shape, so it is parked with the payload
      // intact — the same treatment `WhatsAppEventProcessor` gives a notification
      // it cannot parse, and the difference TAR-663 turned on: recording this as
      // processed is how a paying tenant went unactivated in silence.
      await this.park(parked, PARK_REASON.unrecognisedPayload, tenantId, parsed.detail);
      this.logger.error(
        `Billing event ${claimed.providerEventId} for tenant ${tenantId} could not be read ` +
          `(${parsed.detail}); parked as ${PARK_REASON.unrecognisedPayload}. ` +
          'Fix the mapping and replay the row.',
      );

      return;
    }

    if (parsed.outcome === 'ignored') {
      // Not an event this integration subscribes to. Recorded as processed
      // rather than parked: an event we did not ask for is not a failure, and
      // parking every `benefit_grant.*` would fill the operator's
      // `status = 'failed'` list with noise that hides the rows that matter.
      await this.events.markProcessed(webhookEventId, tenantId);

      return;
    }

    try {
      await this.apply(parked, parsed.event);
    } catch (error: unknown) {
      await this.handleFailure(parked, claimed.attempts, tenantId, error);
    }
  }

  /**
   * The two writes, in order, and the seat push that follows a period roll.
   */
  private async apply(parked: ParkedEvent, event: BillingEvent): Promise<void> {
    const outcome = await this.subscriptions.apply(event);

    if (outcome.result === 'unresolved_plan') {
      // A plan this platform does not carry, and no existing subscription to
      // inherit one from. No retry invents a catalogue row, so it is parked with
      // the payload intact for whoever seeds the mapping.
      await this.park(parked, PARK_REASON.unresolvedPlan, event.tenantId, outcome.detail);
      this.logger.error(
        `Billing event ${event.providerEventId} for tenant ${event.tenantId} could not be ` +
          `applied: ${outcome.detail}. Seed provider_product_id on the plan and replay the row.`,
      );

      return;
    }

    if (outcome.result === 'applied') {
      // After the commit, never inside it. `applyBillingEvent` opens its own
      // transaction and enqueues a notification keyed on the row it writes.
      await this.lifecycle.applyBillingEvent(event);

      // A new period is the moment a deferred seat *reduction* is allowed to be
      // billed — the tenant has paid the old rate through the period it just
      // left. Increases go out immediately from the membership path instead.
      if (event.currentPeriodStart !== null) {
        await this.seats.enqueue(event.tenantId, { allowDecrease: true });
      }
    }

    await this.events.markProcessed(parked.webhookEventId, event.tenantId);
  }

  /**
   * The tenant this delivery is about, in the three-branch order the billing
   * contract fixes.
   *
   *   1. **the metadata we set at checkout** — present on the subscription and
   *      the order the provider derives from it, so this is the path rather than
   *      the exception;
   *   2. `subscriptions.provider_subscription_id`;
   *   3. `subscriptions.provider_customer_id` — the `@@index([providerCustomerId])`
   *      on the model exists for exactly this.
   *
   * Branch 1 is the adapter's answer and needs no query. The other two are reads
   * of *our* table, which is why they live here and not in the adapter: a
   * provider adapter that queried `subscriptions` would be one that knows our
   * schema.
   *
   * `SystemPrisma` because there is no tenant in scope yet — establishing which
   * one it is *is* the work. Both lookups are by a unique-or-indexed provider id
   * and select one column.
   *
   * Takes the subject rather than reading it, because the caller needs the rest
   * of it: `eventType` is what a park alert names, and re-reading the payload to
   * get it would let the two answers drift.
   */
  private async resolveTenant(subject: WebhookSubject): Promise<string | null> {
    if (subject.tenantId !== null) {
      return subject.tenantId;
    }

    if (subject.providerSubscriptionId !== null) {
      const bySubscription = await this.systemPrisma.subscription.findUnique({
        where: { providerSubscriptionId: subject.providerSubscriptionId },
        select: { tenantId: true },
      });

      if (bySubscription !== null) {
        return bySubscription.tenantId;
      }
    }

    if (subject.providerCustomerId !== null) {
      const byCustomer = await this.systemPrisma.subscription.findFirst({
        where: { providerCustomerId: subject.providerCustomerId },
        select: { tenantId: true },
      });

      if (byCustomer !== null) {
        return byCustomer.tenantId;
      }
    }

    return null;
  }

  /**
   * A transient failure: retried until the budget is spent, then parked.
   *
   * Parked rather than left `processing`, so the sweeper stops re-enqueueing a
   * row that has already had every attempt it is going to get, and so the
   * operator's `status = 'failed'` query is a complete list of what needs
   * attention.
   *
   * **The failure is described by its message**, as `WhatsAppEventProcessor`
   * describes its own. This used to call `common/describe-failure`, which is the
   * health endpoint's helper and deliberately reports only an error's `name` or
   * its `errno` — that endpoint answers an unauthenticated caller, and a message
   * there can carry a host name. Neither `webhook_events.last_error` nor the
   * alert raised beside it is that surface, and the cost of reusing it was a
   * parked row reading `attempts_exhausted: Error`, which tells whoever is
   * triaging nothing about what actually failed (TAR-668).
   */
  private async handleFailure(
    parked: ParkedEvent,
    attempts: number,
    tenantId: string,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);

    if (attempts >= this.maxAttempts) {
      await this.park(parked, PARK_REASON.attemptsExhausted, tenantId, reason);
      this.logger.error(
        `Billing event ${parked.webhookEventId} failed ${attempts} times and was parked: ${reason}`,
        error instanceof Error ? error.stack : undefined,
      );

      return;
    }

    await this.events.recordAttemptFailure(parked.webhookEventId, reason);

    // Rethrown so BullMQ retries with backoff. The row stays `processing`, which
    // is re-claimable by design.
    throw error;
  }

  /**
   * Parks the row **and raises the alert** — the single door every billing park
   * goes through, which is the point of it existing (TAR-668).
   *
   * A parked row nobody queries is only marginally better than a dropped one.
   * TAR-663 made unreadable billing webhooks park instead of vanish; this makes
   * the parking audible, so a broken Polar integration surfaces in minutes
   * rather than when a paying tenant complains that they were never activated.
   * Four branches park, and a fifth added later gets the alert for free only if
   * it calls this rather than `markFailed` — that is why the repository method
   * is no longer reached directly from this class.
   *
   * ## What the operator gets, and what is deliberately withheld
   *
   * Enough to triage without opening a database: the row id to reset, the
   * provider's event id to find the delivery in the Polar dashboard, the tenant,
   * the event type, and the `last_error` exactly as written to the row. **Not
   * the payload** — a billing payload carries a customer's name, email and
   * address, `sendDefaultPii` is off for the same reason, and the row itself
   * keeps the payload intact for whoever is authorised to read it.
   *
   * ## Order: the row first, then the alert
   *
   * The row is the durable record and the alert is a notification about it. A
   * tracker outage must not leave a webhook unparked and re-claimable, so the
   * write goes first. `captureMessage` is non-throwing and a no-op without
   * `SENTRY_DSN`, so this adds no failure mode to the worker either way — in
   * local development and CI the log line above each call is the whole record,
   * as it was before.
   */
  private async park(
    parked: ParkedEvent,
    reason: ParkReason,
    tenantId: string | null,
    detail: string | null = null,
  ): Promise<void> {
    const lastError = detail === null ? reason : `${reason}: ${detail}`;

    await this.events.markFailed(parked.webhookEventId, lastError, tenantId);

    this.errorTracking.captureMessage(`Billing webhook parked: ${reason}`, {
      // Low-cardinality only: these become the tracker's filter dimensions, so
      // "every park for this tenant" and "every unresolved plan" are one click.
      tags: {
        provider: BILLING_WEBHOOK_PROVIDER,
        reason,
        tenantId: tenantId ?? 'unresolved',
      },
      extra: {
        webhookEventId: parked.webhookEventId,
        providerEventId: parked.providerEventId,
        eventType: parked.eventType ?? 'none',
        lastError,
        replayWith:
          `UPDATE webhook_events SET status = 'received', attempts = 0, last_error = NULL ` +
          `WHERE id = '${parked.webhookEventId}' AND status = 'failed';`,
      },
    });
  }
}
