import { Inject, Injectable } from '@nestjs/common';
import type { WebhookProvider } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { WebhookEventStatus } from '../generated/prisma/enums';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';

/**
 * Every read and write of `webhook_events`, and the only place `SystemPrisma`
 * is reached from this module.
 *
 * That table is TAR-39's deliberate exception to row-level security: it is
 * written *before* the tenant is known, so it carries a nullable `tenant_id`,
 * has no policy, and the application role is granted nothing on it at all —
 * `TenantPrisma` refuses it outright (`MODEL_POLICIES`, `tenant-scope.extension`).
 * Confining it to one class is what keeps that exception auditable: `SYSTEM_PRISMA`
 * appears in this constructor and in no other file under `webhooks/`.
 *
 * Nothing here is tenant-facing. `tenant_id` is filled in during processing, for
 * forensics and for the sweeper's per-tenant reporting — never to serve a read.
 */
@Injectable()
export class WebhookEventsRepository {
  constructor(@Inject(SYSTEM_PRISMA) private readonly prisma: SystemPrisma) {}

  /**
   * Stores a delivery, absorbing a replay.
   *
   * `skipDuplicates` compiles to `ON CONFLICT (provider, provider_event_id) DO
   * NOTHING`, and `createManyAndReturn` gives back the rows that were actually
   * inserted — so an empty result *is* the duplicate signal, with no second
   * round trip and no read-then-write race between two concurrent deliveries of
   * the same event.
   *
   * Returns `null` when the delivery was a duplicate: the caller answers 200 and
   * enqueues nothing, because the first delivery already did.
   */
  async store(
    provider: WebhookProvider,
    providerEventId: string,
    payload: Prisma.InputJsonValue,
  ): Promise<string | null> {
    const [stored] = await this.prisma.webhookEvent.createManyAndReturn({
      data: [{ provider, providerEventId, payload, status: WebhookEventStatus.received }],
      skipDuplicates: true,
      select: { id: true },
    });

    return stored?.id ?? null;
  }

  /**
   * Takes ownership of an event and returns its payload, or `null` when there is
   * nothing to do.
   *
   * The `status` filter is the concurrency control. Two workers can hold the
   * same job — a Meta retry the sweeper also re-enqueued, a job whose lock
   * expired mid-flight — and `updateMany` scoped to `received`/`processing`
   * means exactly one of them observes a row to work on. A `processed` event is
   * never claimed twice, so replay costs one no-op UPDATE rather than a
   * duplicated message.
   *
   * `processing` is deliberately re-claimable: an event stuck there is the case
   * the sweeper exists for, and refusing to re-claim it would strand it forever.
   *
   * **`failed` is deliberately not claimable, so re-enqueueing a parked event
   * does nothing on its own.** Parking means "this will not succeed as it
   * stands", and a queue that could pick a parked row back up would spend the
   * retry budget on a refusal that has not changed. Replaying one is therefore
   * an explicit operator act — reset the row, and the sweeper takes it from
   * there:
   *
   * ```sql
   * UPDATE webhook_events
   *    SET status = 'received', attempts = 0, last_error = NULL
   *  WHERE id = $1 AND status = 'failed';
   * ```
   *
   * `findStale` picks a `received` row up on the next sweep, which is what makes
   * that one statement the whole procedure. An endpoint for it belongs on the
   * platform-admin surface, where an operator action can be authorised and
   * audited; there is none yet.
   */
  async claim(id: string): Promise<ClaimedWebhookEvent | null> {
    const claimed = await this.prisma.webhookEvent.updateManyAndReturn({
      where: {
        id,
        status: { in: [WebhookEventStatus.received, WebhookEventStatus.processing] },
      },
      data: { status: WebhookEventStatus.processing, attempts: { increment: 1 } },
      // `providerEventId` travels with the payload because for a Standard
      // Webhooks provider it **is** a header (`webhook-id`), and the headers are
      // gone by the time a worker runs off the stored row. Storing it in the
      // column and handing it back here is what lets the worker reconstruct the
      // one field the replay defence turns on, without widening the job payload
      // or re-reading the row.
      select: { id: true, providerEventId: true, payload: true, attempts: true },
    });

    return claimed[0] ?? null;
  }

  /** Records success, and the tenant the event turned out to belong to. */
  async markProcessed(id: string, tenantId: string | null): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { status: WebhookEventStatus.processed, tenantId, processedAt: new Date() },
    });
  }

  /**
   * Parks an event, with the reason.
   *
   * Parked, never dropped (TAR-39, failure modes): the row keeps its raw payload
   * and stays queryable by `status = 'failed'`, so an unknown `phone_number_id`
   * — a number connected before its tenant record existed — can be replayed once
   * the tenant is there rather than lost. Replay is the status reset described
   * on `claim`, not a re-enqueue: a parked row is not claimable by design.
   */
  async markFailed(id: string, reason: string, tenantId: string | null = null): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { status: WebhookEventStatus.failed, lastError: reason, tenantId },
    });
  }

  /** Records a retriable failure without giving up on the event. */
  async recordAttemptFailure(id: string, reason: string): Promise<void> {
    await this.prisma.webhookEvent.update({ where: { id }, data: { lastError: reason } });
  }

  /**
   * Ids of **one provider's** events still `received`, or stuck in `processing`,
   * since before `staleBefore` — what that provider's sweeper re-enqueues.
   *
   * The `provider` filter is not a convenience. Each provider has its own queue
   * and its own worker (`WEBHOOKS_QUEUE` for Meta, `BILLING_QUEUE` for TAR-37),
   * and a worker fails loudly on a job name its handler map does not carry — so
   * an unfiltered sweep would hand Polar's rows to the WhatsApp processor, which
   * would park every one of them `failed` with an unrecognised payload. It costs
   * nothing: `provider` is the leading column of the `(provider,
   * provider_event_id)` unique index, and the predicate narrows the same
   * `(status, received_at)` scan this query has always used.
   *
   * Ordered oldest first and bounded by `limit`, so a backlog drains in arrival
   * order across several sweeps instead of one sweep trying to load all of it.
   * Only the id is selected, because that is all the job payload carries.
   */
  async findStale(provider: WebhookProvider, staleBefore: Date, limit: number): Promise<string[]> {
    const stale = await this.prisma.webhookEvent.findMany({
      where: {
        provider,
        status: { in: [WebhookEventStatus.received, WebhookEventStatus.processing] },
        receivedAt: { lt: staleBefore },
      },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true },
    });

    return stale.map(({ id }) => id);
  }
}

export interface ClaimedWebhookEvent {
  readonly id: string;
  /** The provider's own event id — for Standard Webhooks, the `webhook-id` header. */
  readonly providerEventId: string;
  readonly payload: Prisma.JsonValue;
  /** How many times processing has been attempted, including this one. */
  readonly attempts: number;
}
