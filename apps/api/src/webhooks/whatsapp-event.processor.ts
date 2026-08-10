import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { WEBHOOK_FAILURE_REASON, describeFailure } from './webhook-failure-reasons';
import { WebhookEventsRepository } from './webhook-events.repository';
import { WhatsAppAccountResolver } from './whatsapp-account.resolver';
import { WhatsAppInboundWriter, type RoutedWhatsAppAccount } from './whatsapp-inbound.writer';
import {
  MESSAGES_FIELD,
  WhatsAppChangeValueSchema,
  WhatsAppNotificationSchema,
  type WhatsAppChangeValue,
} from './whatsapp-payload.schema';

/**
 * The worker half of the pipeline: take a stored `webhook_events` row, route it
 * to a tenant, and write what it says.
 *
 * It runs against the durable row rather than against an HTTP request, which is
 * what makes every decision here retriable. Three outcomes, and the difference
 * between them matters operationally:
 *
 *   * **processed** — applied, and the tenant recorded for forensics;
 *   * **parked `failed`** — something about the payload will never succeed on a
 *     retry (an unknown number, an unparseable body, a deactivated tenant). The
 *     row keeps its raw payload and stays queryable, so it can be replayed once
 *     the cause is fixed. Never dropped;
 *   * **rethrown** — a transient fault. BullMQ retries with backoff, and the
 *     sweeper is the backstop if the queue itself is the thing that failed.
 */
@Injectable()
export class WhatsAppEventProcessor {
  private readonly logger = new Logger(WhatsAppEventProcessor.name);
  private readonly maxAttempts: number;

  constructor(
    config: ConfigService,
    private readonly events: WebhookEventsRepository,
    private readonly accounts: WhatsAppAccountResolver,
    private readonly writer: WhatsAppInboundWriter,
    private readonly tenantContext: TenantContextService,
  ) {
    this.maxAttempts = config.getOrThrow<number>('WEBHOOK_MAX_ATTEMPTS');
  }

  async process(webhookEventId: string): Promise<void> {
    const claimed = await this.events.claim(webhookEventId);

    if (claimed === null) {
      // Already `processed` or already parked `failed`. A Meta retry, a sweeper
      // re-enqueue and an expired job lock all land here, and all three cost one
      // no-op UPDATE rather than a duplicated message.
      return;
    }

    const parsed = WhatsAppNotificationSchema.safeParse(claimed.payload);

    if (!parsed.success) {
      // Signed by Meta, so it is genuinely from Meta — but not a shape this
      // processor understands. Retrying cannot change that, so it is parked
      // with the payload intact rather than burning the retry budget.
      await this.events.markFailed(
        webhookEventId,
        describeFailure(WEBHOOK_FAILURE_REASON.unrecognisedPayload, parsed.error.message),
      );
      return;
    }

    try {
      const outcome = await this.apply(parsed.data.entry.flatMap((entry) => entry.changes));

      if (outcome.parkedReason !== null) {
        await this.events.markFailed(webhookEventId, outcome.parkedReason, outcome.tenantId);
        return;
      }

      await this.events.markProcessed(webhookEventId, outcome.tenantId);
    } catch (error: unknown) {
      await this.handleFailure(webhookEventId, claimed.attempts, error);
    }
  }

  /**
   * Applies every `messages` change in the batch.
   *
   * A batch may name more than one number, and therefore more than one tenant,
   * so each change opens its own tenant scope rather than mutating one. Nesting
   * scopes instead of reusing one is what stops tenant A's context leaking into
   * tenant B's writes when Meta batches two numbers into one delivery.
   *
   * Changes are applied one at a time and every write is idempotent, so a
   * partial batch is safe to replay: the parts that succeeded become no-ops.
   */
  private async apply(
    changes: readonly { field: string; value: unknown }[],
  ): Promise<ApplyOutcome> {
    let tenantId: string | null = null;
    let parkedReason: string | null = null;

    for (const change of changes) {
      if (change.field !== MESSAGES_FIELD) {
        // `message_template_status_update`, `account_update` and friends arrive
        // on the same URL, in the same delivery as real messages, and carry a
        // different value shape — no `metadata`, so no routing key. Recorded as
        // processed; TAR-52's template sync owns them, not this pipeline.
        //
        // Skipped *before* the value is parsed, which is the whole reason the
        // envelope leaves it unvalidated: validating every change against the
        // `messages` shape would fail the batch over a change this pipeline was
        // never going to read, and the message beside it would be parked.
        continue;
      }

      const value = WhatsAppChangeValueSchema.safeParse(change.value);

      if (!value.success) {
        // A `messages` change this processor cannot read is genuinely
        // unrecognisable, and no retry changes that — but only this change is
        // parked, and the batch's other changes still apply.
        parkedReason ??= describeFailure(
          WEBHOOK_FAILURE_REASON.unrecognisedPayload,
          value.error.message,
        );
        continue;
      }

      const phoneNumberId = value.data.metadata.phone_number_id;
      const account = await this.accounts.resolve(phoneNumberId);

      if (account === null) {
        parkedReason ??= describeFailure(
          WEBHOOK_FAILURE_REASON.unknownPhoneNumber,
          `no whatsapp_accounts row for ${phoneNumberId}`,
        );
        this.logger.warn(`Webhook for unknown phone_number_id ${phoneNumberId} parked`);
        continue;
      }

      tenantId ??= account.tenantId;

      const reason = await this.applyForTenant(account, value.data);

      parkedReason ??= reason;
    }

    return { tenantId, parkedReason };
  }

  /** Opens the tenant scope every `TenantPrisma` statement below reads. */
  private async applyForTenant(
    account: RoutedWhatsAppAccount,
    value: WhatsAppChangeValue,
  ): Promise<string | null> {
    return await this.tenantContext.run(
      {
        requestId: this.tenantContext.requestId ?? 'webhook',
        tenantId: account.tenantId,
        userId: null,
      },
      async () => await this.writeChange(account, value),
    );
  }

  private async writeChange(
    account: RoutedWhatsAppAccount,
    value: WhatsAppChangeValue,
  ): Promise<string | null> {
    const displayNames = toDisplayNames(value);
    let unroutable: string | null = null;

    try {
      for (const message of value.messages ?? []) {
        const attributed = await this.writer.applyInboundMessage(account, message, {
          displayName: displayNames.get(message.from) ?? null,
        });

        if (!attributed) {
          unroutable ??= describeFailure(
            WEBHOOK_FAILURE_REASON.unroutableContact,
            `wa_id ${message.from} is not an E.164 number`,
          );
        }
      }

      for (const update of value.statuses ?? []) {
        const attributed = await this.writer.applyStatusUpdate(account, update);

        if (!attributed) {
          unroutable ??= describeFailure(
            WEBHOOK_FAILURE_REASON.unroutableContact,
            `wa_id ${update.recipient_id} is not an E.164 number`,
          );
        }
      }
    } catch (error: unknown) {
      if (error instanceof TenantNotActiveError) {
        // Deactivation retains data and revokes access (TAR-51). Parking keeps
        // the message replayable if the tenant comes back, and stops the retry
        // budget being spent on a refusal that will not change.
        return describeFailure(WEBHOOK_FAILURE_REASON.tenantNotActive, error.tenantId);
      }

      throw error;
    }

    return unroutable;
  }

  /**
   * Decides whether a fault is worth another attempt.
   *
   * The counter lives on the row, not on the job, so a sweeper re-enqueue after
   * a Redis outage cannot silently reset the budget — and an event that has
   * genuinely exhausted it is parked rather than left cycling.
   */
  private async handleFailure(
    webhookEventId: string,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);

    if (attempts >= this.maxAttempts) {
      await this.events.markFailed(
        webhookEventId,
        describeFailure(WEBHOOK_FAILURE_REASON.attemptsExhausted, detail),
      );
      this.logger.error(
        `Webhook event ${webhookEventId} parked after ${attempts} attempts: ${detail}`,
      );
      return;
    }

    await this.events.recordAttemptFailure(webhookEventId, detail);

    // Rethrown so BullMQ applies its backoff. The row stays `processing`, which
    // is exactly the state the sweeper reclaims if the queue never comes back.
    throw error;
  }
}

interface ApplyOutcome {
  /** The tenant this delivery turned out to belong to, recorded for forensics. */
  readonly tenantId: string | null;
  /** Non-null when the event should be parked rather than marked processed. */
  readonly parkedReason: string | null;
}

/** `wa_id` → the profile name Meta sent with this batch, when it sent one. */
function toDisplayNames(value: WhatsAppChangeValue): ReadonlyMap<string, string> {
  const names = new Map<string, string>();

  for (const contact of value.contacts ?? []) {
    const name = contact.profile?.name;

    if (name !== undefined && name.length > 0) {
      names.set(contact.wa_id, name);
    }
  }

  return names;
}
