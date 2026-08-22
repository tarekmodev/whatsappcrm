import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OutboundEmailTemplate, VolumePolicy } from '@whatsappcrm/contracts';
import {
  CONVERSATION_VOLUME_CHANGED_EVENT,
  type ConversationVolumeChangedEvent,
} from '../events/domain-events';
import { OnEvent } from '@nestjs/event-emitter';
import { MAILER, type MailerPort } from '../identity/mailer/mailer.port';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';

/**
 * Tells a tenant admin that their conversation allowance is running out, and
 * what the configured policy will do about it.
 *
 * ## Two notices, and the policy is named in both
 *
 * `volume_warning` when the count crosses `BILLING_VOLUME_WARN_AT` of the cap,
 * and `volume_limit_reached` when it reaches the cap itself. Both carry the
 * effective policy in their data, because "you have used 800 of 1,000" means
 * something very different depending on whether the thousandth conversation
 * stops replies going out. TAR-37's acceptance criterion is that the policy is a
 * documented setting rather than implicit behaviour, and the message a tenant
 * actually receives is where that has to be true.
 *
 * ## Once per period, without a table to remember it
 *
 * The event carries the count **after** an increment of one, so the previous
 * count is exactly `opened - 1` and a crossing is
 * `opened - 1 < threshold <= opened`. That is true for exactly one event per
 * period by construction, and the row lock the upsert took is what makes it hold
 * under concurrency.
 *
 * The alternative — a `(tenant_id, period_start, kind)` row asserting the notice
 * has been sent — needs a table this story is not allowed to migrate, and would
 * be a read-then-write with a race between the two halves. This has neither
 * problem, and the property it trades away is small: if the counter is ever
 * corrected downwards by a reconciliation, a second crossing can re-notify. A
 * tenant told twice that they are near their limit is a far better failure than
 * one told nothing.
 *
 * ## Failure is silent to the caller, loud in the log
 *
 * The subscriber runs off the in-process bus, dispatched without an await from
 * the inbound path. A mailer outage must not fail a customer's message, so every
 * failure here is caught and logged: the notice is a courtesy, and the console's
 * own banner reads the same numbers from `GET /billing/usage` regardless.
 */
@Injectable()
export class VolumeNotifierService {
  private readonly logger = new Logger(VolumeNotifierService.name);
  private readonly warnAt: number;
  private readonly policy: VolumePolicy;

  constructor(
    config: ConfigService,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
  ) {
    this.warnAt = config.getOrThrow<number>('BILLING_VOLUME_WARN_AT');
    this.policy = config.getOrThrow<VolumePolicy>('BILLING_VOLUME_POLICY');
  }

  @OnEvent(CONVERSATION_VOLUME_CHANGED_EVENT)
  async onVolumeChanged(event: ConversationVolumeChangedEvent): Promise<void> {
    const template = this.crossedTemplate(event);

    if (template === null) {
      return;
    }

    try {
      await this.notifyAdmins(event, template);
    } catch (error: unknown) {
      // Never rethrown. This handler is dispatched from the inbound-message path
      // without an await, and an unhandled rejection there is a process-level
      // warning about a customer's message that was in fact stored correctly.
      this.logger.error(
        `Could not send the ${template} notice for tenant ${event.tenantId}.`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Which notice this increment crossed into, or `null` for the overwhelming
   * majority of conversations that cross nothing.
   *
   * The cap is checked before the warning line, so a plan small enough that the
   * two coincide — `warnAt * cap` rounding up to `cap`, as it does for a cap of
   * 1 — sends the notice that actually matters rather than the softer one.
   */
  private crossedTemplate(event: ConversationVolumeChangedEvent): OutboundEmailTemplate | null {
    const previous = event.opened - 1;

    if (previous < event.cap && event.opened >= event.cap) {
      return 'volume_limit_reached';
    }

    const warnThreshold = Math.ceil(event.cap * this.warnAt);

    if (previous < warnThreshold && event.opened >= warnThreshold) {
      return 'volume_warning';
    }

    return null;
  }

  /**
   * Sends to every active admin of the tenant.
   *
   * `SystemPrisma` because this runs from a queue worker with no session and no
   * tenant scope, and because the notice has to reach a tenant that is
   * `past_due` — which `TenantPrisma` would refuse. The statement names one
   * tenant, by id, taken from the event.
   *
   * The same recipient predicate `TenantLifecycleNotifier` uses: `role = 'admin'`
   * and `status = 'active'`. A tenant with no active admin is logged rather than
   * silently skipped — nobody being told is a fact worth seeing.
   */
  private async notifyAdmins(
    event: ConversationVolumeChangedEvent,
    template: OutboundEmailTemplate,
  ): Promise<void> {
    const admins = await this.systemPrisma.user.findMany({
      where: { tenantId: event.tenantId, role: 'admin', status: 'active' },
      select: { email: true },
    });

    if (admins.length === 0) {
      this.logger.warn(
        `Tenant ${event.tenantId} crossed its conversation allowance with no active admin to ` +
          'tell. Nobody was emailed.',
      );

      return;
    }

    const data = {
      // Strings, because `OutboundEmail.data` is a string map — the adapter
      // renders them and never does arithmetic on them.
      opened: String(event.opened),
      cap: String(event.cap),
      periodStart: event.periodStart.toISOString(),
      // The documented setting, in the message. Under `warn` the tenant keeps
      // replying; under `block` it does not, and being told which is the point.
      policy: this.policy,
    };

    for (const admin of admins) {
      await this.mailer.send({ to: admin.email, template, tenantId: event.tenantId, data });
    }

    this.logger.log(
      `Sent ${template} to ${admins.length} admin(s) of tenant ${event.tenantId} ` +
        `(${event.opened} of ${event.cap}, policy ${this.policy}).`,
    );
  }
}
