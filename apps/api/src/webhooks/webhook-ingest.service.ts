import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../generated/prisma/client';
import { PROCESS_WEBHOOK_EVENT_JOB, WEBHOOKS_QUEUE } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import type { ProcessWebhookEventJob } from './webhook-jobs';
import { processWebhookEventJobId } from './webhook-jobs';
import { WebhookEventsRepository } from './webhook-events.repository';
import { WebhookChannelNotConfiguredError, WebhookSignatureInvalidError } from './webhook.errors';
import { isValidWhatsAppSignature, matchesVerifyToken } from './whatsapp-signature';

/** Meta's provider key in `webhook_events.provider`. */
const WHATSAPP_PROVIDER = 'whatsapp';

/** What `store` did, so the controller can log a replay without a second query. */
export type IngestOutcome = 'stored' | 'duplicate';

/**
 * The ingest half of the pipeline: verify, store, answer, then enqueue — in that
 * order, which is the whole of ADR 0001's durability rule.
 *
 * The order is the design. Enqueueing straight to Redis would make a Redis
 * outage silent, permanent message loss, because Meta retries with backoff and
 * then gives up. Writing to Postgres first demotes Redis to a latency
 * dependency: if the enqueue fails, the row is still there and the sweeper picks
 * it up. That is why `enqueue` below is allowed to fail without failing the
 * request.
 */
@Injectable()
export class WebhookIngestService {
  private readonly logger = new Logger(WebhookIngestService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly events: WebhookEventsRepository,
    private readonly queue: QueueService,
  ) {}

  /**
   * Meta's `GET` handshake. Returns the challenge to echo, and throws otherwise
   * — the caller must never echo on a mismatch, since echoing is what registers
   * the URL.
   */
  verifyHandshake(candidateToken: string, challenge: string): string {
    const expected = this.config.get<string>('WHATSAPP_WEBHOOK_VERIFY_TOKEN');

    if (expected === undefined || expected.length === 0) {
      throw new WebhookChannelNotConfiguredError('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
    }

    if (!matchesVerifyToken(candidateToken, expected)) {
      throw new WebhookSignatureInvalidError();
    }

    return challenge;
  }

  /**
   * Verifies the signature, stores the payload, and enqueues processing.
   *
   * Nothing is written before the signature check passes: an unsigned payload
   * must not be able to grow the table, which is the one thing an anonymous
   * caller could otherwise do to a public route with no rate limit (webhook
   * routes are exempt from throttling — throttling Meta causes retries and
   * eventually lost messages).
   */
  async ingestWhatsApp(
    rawBody: Buffer | undefined,
    signatureHeader: unknown,
  ): Promise<IngestOutcome> {
    const appSecret = this.config.get<string>('WHATSAPP_APP_SECRET');

    if (appSecret === undefined || appSecret.length === 0) {
      throw new WebhookChannelNotConfiguredError('WHATSAPP_APP_SECRET');
    }

    // The `undefined` check is what narrows `rawBody` for the two calls below;
    // it is also the only signal that Nest's `rawBody` option went missing from
    // bootstrap, which would otherwise present as every delivery being refused.
    if (rawBody === undefined || !isValidWhatsAppSignature(rawBody, signatureHeader, appSecret)) {
      throw new WebhookSignatureInvalidError();
    }

    const providerEventId = toProviderEventId(rawBody);
    const storedId = await this.events.store(
      WHATSAPP_PROVIDER,
      providerEventId,
      parsePayload(rawBody),
    );

    if (storedId === null) {
      // Meta retried a delivery we already hold. The unique constraint absorbed
      // it; enqueueing again would be harmless but pointless work.
      this.logger.debug(`Duplicate WhatsApp delivery ${providerEventId} ignored`);
      return 'duplicate';
    }

    await this.enqueue(storedId);

    return 'stored';
  }

  private async enqueue(webhookEventId: string): Promise<void> {
    const job: ProcessWebhookEventJob = { tenantId: null, webhookEventId };

    const outcome = await this.queue.enqueue(WEBHOOKS_QUEUE, PROCESS_WEBHOOK_EVENT_JOB, job, {
      jobId: processWebhookEventJobId(webhookEventId),
      attempts: this.config.getOrThrow<number>('WEBHOOK_MAX_ATTEMPTS'),
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });

    if (outcome === 'added' || outcome === 'duplicate') {
      // No `detectDuplicate` on this call: this path is inside Meta's request
      // timeout, and it would act on both answers identically anyway. If BullMQ
      // does hold a retained job under this id, the row stays `received` and the
      // sweeper reclaims it under an id of its own.
      return;
    }

    // Not an error for the caller: the payload is durable and the sweeper
    // re-enqueues anything nothing picked up. Logged at warn because a
    // sustained run of these means the queue is down and the inbox is going
    // stale even though nothing is being lost.
    this.logger.warn(
      `Stored webhook event ${webhookEventId} was not enqueued (${outcome}); left to the sweeper`,
    );
  }
}

/**
 * The idempotency key for a delivery: SHA-256 of the exact bytes Meta sent.
 *
 * Meta's `messages` webhook carries no delivery id of its own — there is no
 * header or envelope field to key on — so one has to be derived, and it has to
 * be derived from something a retry reproduces exactly. A retry replays the
 * identical body, so the digest is identical and `ON CONFLICT DO NOTHING`
 * absorbs it.
 *
 * The alternative, keying on the first `messages[].id`, is worse in both
 * directions: a batch carries several ids, and a `statuses` batch carries ids of
 * messages that already exist, so two genuinely different notifications about
 * one message would collide.
 *
 * Two distinct deliveries would have to be byte-identical to collapse. Every
 * Meta payload carries per-message ids and a timestamp, so that is a
 * duplicate — which is exactly what this is meant to catch.
 */
function toProviderEventId(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * The payload as stored. Parsed rather than kept as text because the column is
 * `jsonb`, and re-parsed from the raw bytes rather than taken from Express's
 * parsed body so that what is stored is provably what was signed.
 *
 * A body that is not JSON cannot reach here: the signature proved Meta sent it,
 * and Meta sends JSON. If that ever stops being true, the throw is the right
 * answer — a 500 and a log line, rather than a row that claims to hold a
 * payload it does not.
 */
function parsePayload(rawBody: Buffer): Prisma.InputJsonValue {
  return JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue;
}
