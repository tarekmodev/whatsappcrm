import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BILLING_PROVIDER, type BillingProvider } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { BILLING_QUEUE, PROCESS_BILLING_EVENT_JOB } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { WebhookEventsRepository } from '../webhooks/webhook-events.repository';
import { BillingWebhookRefusedError } from './billing.errors';
import { BILLING_WEBHOOK_PROVIDER, processBillingEventJobId } from './billing.constants';
import type { ProcessBillingEventJob } from './billing-jobs';

/** Standard Webhooks' id and timestamp headers, lower-cased as Express indexes them. */
const WEBHOOK_ID_HEADER = 'webhook-id';
const WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp';

/** What `ingest` did, so the controller can log a replay without a second query. */
export type BillingIngestOutcome = 'stored' | 'duplicate';

/**
 * The ingest half of the billing webhook pipeline: **verify, store, answer,
 * enqueue** — in that order, which is the whole of the durability rule
 * `WebhookIngestService` already follows for Meta.
 *
 * The order is the design. Enqueueing straight to Redis would make a Redis
 * outage silent, permanent loss of billing events: Polar retries ten times with
 * backoff and then **disables the endpoint**, which is the single
 * highest-severity failure in this subsystem. Writing to Postgres first demotes
 * Redis to a latency dependency — if the enqueue fails the row is still there
 * and the sweeper picks it up.
 *
 * ## The whole replay defence is one statement
 *
 * `INSERT … ON CONFLICT (provider, provider_event_id) DO NOTHING`. Zero rows
 * inserted **is** the duplicate signal, with no read-then-write race between two
 * concurrent deliveries of the same event. The key is the `webhook-id` header,
 * which is what Standard Webhooks specifies as the idempotency key and which
 * exists whether or not Polar puts an id in the body.
 *
 * `provider` is `'billing'`, not `'polar'`. The published `WEBHOOK_PROVIDERS`
 * enum carries the former, and it is also the right value on principle: a Polar
 * string written by a service outside `providers/polar/` is exactly the leak the
 * port exists to prevent, and it would have to be migrated the day a second
 * provider is added.
 *
 * ## Nothing is written before the signature passes
 *
 * An unsigned payload must not be able to grow the table, which is the one thing
 * an anonymous caller could otherwise do to a public route that is deliberately
 * exempt from rate limiting — throttling Polar causes retries and eventually a
 * disabled endpoint.
 */
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);
  private readonly toleranceMs: number;
  private readonly maxAttempts: number;

  constructor(
    config: ConfigService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly events: WebhookEventsRepository,
    private readonly queue: QueueService,
  ) {
    this.toleranceMs = config.getOrThrow<number>('BILLING_WEBHOOK_TOLERANCE_MS');
    this.maxAttempts = config.getOrThrow<number>('WEBHOOK_MAX_ATTEMPTS');
  }

  async ingest(
    rawBody: Buffer | undefined,
    headers: Record<string, string | undefined>,
  ): Promise<BillingIngestOutcome> {
    // The `undefined` check narrows `rawBody` for the verification below, and it
    // is also the only signal that Nest's `rawBody` option went missing from
    // bootstrap — which would otherwise present as every delivery being refused
    // and be diagnosed as a wrong secret.
    if (rawBody === undefined) {
      throw new BillingWebhookRefusedError('no raw body: is rawBody enabled in bootstrap?');
    }

    if (!this.provider.verifyWebhookSignature(rawBody, headers)) {
      throw new BillingWebhookRefusedError('signature verification failed');
    }

    this.assertFreshTimestamp(headers[WEBHOOK_TIMESTAMP_HEADER]);

    const providerEventId = headers[WEBHOOK_ID_HEADER];

    if (providerEventId === undefined || providerEventId.length === 0) {
      // Signed by the provider, so it is genuinely theirs — but with no
      // `webhook-id` there is no idempotency key, and storing it would mean a
      // redelivery applied twice. Refusing is the safe direction; it would take
      // a change to the signing spec to reach this.
      throw new BillingWebhookRefusedError('no webhook-id header to key idempotency on');
    }

    const storedId = await this.events.store(
      BILLING_WEBHOOK_PROVIDER,
      providerEventId,
      parsePayload(rawBody),
    );

    if (storedId === null) {
      // A redelivery of an event we already hold. The unique constraint absorbed
      // it; the first delivery already enqueued the work.
      this.logger.debug(`Duplicate billing delivery ${providerEventId} ignored`);

      return 'duplicate';
    }

    await this.enqueue(storedId);

    return 'stored';
  }

  /**
   * Refuses a delivery whose signed timestamp is far enough from now to be a
   * replay of a captured request.
   *
   * Standard Webhooks signs the timestamp for exactly this: without the check a
   * signature stays valid forever, and a delivery captured from a log or a proxy
   * could be re-presented at any time. The window is two-sided — a timestamp in
   * the *future* is as suspicious as a stale one and usually means clock skew
   * worth noticing.
   *
   * A missing or unparseable timestamp is refused rather than waved through: it
   * is part of the signed content, so its absence means the delivery was not
   * signed the way the spec says it was.
   */
  private assertFreshTimestamp(timestamp: string | undefined): void {
    if (timestamp === undefined) {
      throw new BillingWebhookRefusedError('no webhook-timestamp header');
    }

    // Standard Webhooks sends seconds since the epoch.
    const seconds = Number(timestamp);

    if (!Number.isFinite(seconds)) {
      throw new BillingWebhookRefusedError('webhook-timestamp is not a number');
    }

    const skewMs = Math.abs(Date.now() - seconds * 1_000);

    if (skewMs > this.toleranceMs) {
      throw new BillingWebhookRefusedError(
        `webhook-timestamp is ${Math.round(skewMs / 1_000)}s from now`,
      );
    }
  }

  private async enqueue(webhookEventId: string): Promise<void> {
    const job: ProcessBillingEventJob = { tenantId: null, webhookEventId };

    const outcome = await this.queue.enqueue(BILLING_QUEUE, PROCESS_BILLING_EVENT_JOB, job, {
      jobId: processBillingEventJobId(webhookEventId),
      attempts: this.maxAttempts,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });

    if (outcome === 'added' || outcome === 'duplicate') {
      return;
    }

    // Not an error for the caller: the payload is durable and the sweeper
    // re-enqueues anything nothing picked up. Logged at warn because a sustained
    // run of these means subscriptions are going stale even though no event is
    // being lost.
    this.logger.warn(
      `Stored billing event ${webhookEventId} was not enqueued (${outcome}); left to the sweeper`,
    );
  }
}

/**
 * The payload as stored. Re-parsed from the raw bytes rather than taken from
 * Express's parsed body, so what is stored is provably what was signed.
 *
 * A body that is not JSON cannot reach here: the signature proved the provider
 * sent it, and the provider sends JSON. If that ever stops being true the throw
 * is the right answer — a 500 and a log line, rather than a row that claims to
 * hold a payload it does not.
 */
function parsePayload(rawBody: Buffer): Prisma.InputJsonValue {
  return JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue;
}
