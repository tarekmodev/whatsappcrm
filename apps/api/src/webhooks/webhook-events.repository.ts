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
   * there. `replay` below is that reset, authorised and audited on the
   * platform-admin surface (TAR-94), and `findStale` collecting a `received` row
   * on the next sweep is what makes one UPDATE the whole procedure.
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
   * the tenant is there rather than lost. Replay is `replay` below: the status
   * reset described on `claim`, not a re-enqueue, because a parked row is not
   * claimable by design.
   */
  async markFailed(id: string, reason: string, tenantId: string | null = null): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { status: WebhookEventStatus.failed, lastError: reason, tenantId },
    });
  }

  /**
   * Puts a parked event back in front of the sweeper, and records who did it
   * (TAR-94).
   *
   * The reset and the trail row are one transaction on purpose, for the same
   * reason `AuditService` takes its caller's transaction client: an event that
   * is replayed with nothing saying who replayed it, and a row claiming a replay
   * that then rolled back, are both worse than the failure that would have
   * produced them. Two statements, one commit.
   *
   * **The `status` filter on the UPDATE is the concurrency control**, exactly as
   * in `claim`. Two operators replaying the same row at once both read `failed`;
   * only one of them matches a row, and the other is told the row is no longer
   * parked rather than adding a second trail entry for a reset that already
   * happened.
   *
   * `attempts` goes back to zero because the retry budget belongs to the
   * *attempt* to apply an event rather than to the event: a row parked with
   * `attempts_exhausted` and replayed with its attempts intact would be parked
   * again by the first transient failure. `last_error` is cleared for the same
   * reason — which is why `parked_error` on the trail row is a copy, since after
   * this commits the row itself no longer says what was being recovered.
   *
   * Nothing is enqueued. `findStale` collects a `received` row on the next sweep,
   * and a second path onto the queue here would be a second way for one event to
   * be in flight — the shape of the job-id collision TAR-67 fixed.
   */
  async replay(id: string, actorLabel: string): Promise<WebhookEventReplayOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      const parked = await tx.webhookEvent.findUnique({
        where: { id },
        select: { provider: true, status: true, lastError: true },
      });

      if (parked === null) {
        return { kind: 'not-found' };
      }

      if (parked.status !== WebhookEventStatus.failed) {
        return { kind: 'not-parked', status: parked.status };
      }

      const { count } = await tx.webhookEvent.updateMany({
        where: { id, status: WebhookEventStatus.failed },
        data: { status: WebhookEventStatus.received, attempts: 0, lastError: null },
      });

      if (count === 0) {
        // Parked when it was read and not now: a concurrent replay committed in
        // between. Re-read rather than report the status from above, so the
        // answer describes the row as it actually stands.
        const current = await tx.webhookEvent.findUnique({
          where: { id },
          select: { status: true },
        });

        return current === null
          ? { kind: 'not-found' }
          : { kind: 'not-parked', status: current.status };
      }

      const { replayedAt } = await tx.webhookEventReplay.create({
        data: { webhookEventId: id, actorLabel, parkedError: parked.lastError },
        select: { replayedAt: true },
      });

      return {
        kind: 'replayed',
        event: {
          // `webhook_events.provider` is a TEXT column, and `store` — the only
          // statement in the platform that writes it — takes a `WebhookProvider`.
          // The assertion states that, so the published response can carry the
          // union instead of widening the contract to a bare string.
          provider: parked.provider as WebhookProvider,
          id,
          parkedError: parked.lastError,
          replayedAt,
        },
      };
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

/**
 * What a replay did, as a discriminated union rather than a boolean and a
 * nullable field.
 *
 * Three genuinely different answers — an id nobody stored, a row that is not
 * parked, and a row that has been reset — and the caller maps each to its own
 * status code. A union is what stops a fourth being added later without every
 * call site being made to handle it.
 */
export type WebhookEventReplayOutcome =
  | { readonly kind: 'replayed'; readonly event: ReplayedWebhookEvent }
  | { readonly kind: 'not-found' }
  /** The row exists and is `received`, `processing` or `processed`. */
  | { readonly kind: 'not-parked'; readonly status: WebhookEventStatus };

export interface ReplayedWebhookEvent {
  readonly id: string;
  /**
   * Which pipeline owns the row, and therefore which sweeper will collect it.
   * Reported rather than assumed: only the WhatsApp sweep runs today, so a
   * `billing` row reset to `received` waits for the worker TAR-37 adds.
   */
  readonly provider: WebhookProvider;
  /** The `last_error` the row carried, captured before the reset cleared it. */
  readonly parkedError: string | null;
  /** When the reset committed — not when the sweeper will collect it. */
  readonly replayedAt: Date;
}

export interface ClaimedWebhookEvent {
  readonly id: string;
  /** The provider's own event id — for Standard Webhooks, the `webhook-id` header. */
  readonly providerEventId: string;
  readonly payload: Prisma.JsonValue;
  /** How many times processing has been attempted, including this one. */
  readonly attempts: number;
}
