import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OutboundEmailTemplate, TenantStatus } from '@whatsappcrm/contracts';
import { MAILER, type MailerPort } from '../../identity/mailer/mailer.port';
import { SYSTEM_PRISMA, type SystemPrisma } from '../../prisma/prisma.tokens';
import { LifecycleEventNotFoundError } from './tenant-lifecycle.errors';

/**
 * Which template a transition sends (ADR 0009 decision 7's table).
 *
 * `past_due` is the only arrival whose template depends on where it came from —
 * a trial running out and a card failing are the same state and completely
 * different emails — so it is the one entry that is a function rather than a
 * value.
 */
function templateFor(from: TenantStatus | null, to: TenantStatus): OutboundEmailTemplate | null {
  switch (to) {
    case 'trialing':
      return 'tenant_welcome';
    case 'past_due':
      return from === 'trialing' ? 'trial_expired' : 'payment_failed';
    case 'cancelled':
      return 'tenant_cancelled';
    case 'suspended':
      return 'tenant_suspended';
    case 'deleted':
      // `tenant_deleted` is the one notice this function does not own, and it
      // cannot: by the time the `→ deleted` transition is written, `users` has
      // been emptied, so there is nobody left to address it to.
      // `TenantPurgeService` reads the recipients and sends it in the
      // transaction that stamps `purge_started_at`, before the first `DELETE` —
      // which is what 0009 means by "last statement before the purge begins".
      // The event row is still claimed, so the backstop does not re-queue a job
      // with nothing to do.
      return null;
    case 'active':
      // Only a *return* is worth an email. `created → active` is an operator
      // provisioning a tenant, whose admin does not exist yet and is told by the
      // operator; `trialing → active` is a trial converting, which is billing's
      // receipt to send rather than a lifecycle notice.
      return from === 'suspended' || from === 'past_due' || from === 'cancelled'
        ? 'tenant_reactivated'
        : null;
    default:
      // `created` is written by provisioning inside the insert, never by a
      // transition, and has nobody to write to.
      return null;
  }
}

/**
 * Sends the tenant-admin email for one committed `lifecycle_events` row, and
 * stamps `notified_at` so nothing sends it twice (ADR 0009 decision 7).
 *
 * ## Why it runs off the row rather than off the transition
 *
 * The transition transaction writes `tenants` and `lifecycle_events` and does
 * **not** send an email: a mailer outage that rolled back a suspension would
 * leave a tenant that should have been locked out still running, which is the
 * wrong failure. So the row is the truth and the queue is an accelerator — the
 * same durability shape as webhook ingest. If Redis is down the transaction has
 * already committed, `notified_at` stays null, and the lifecycle sweep
 * re-enqueues anything still owing a minute later.
 *
 * ## Idempotent three times over
 *
 * The BullMQ job id is the row id, so a redelivery is a duplicate BullMQ
 * discards; this handler re-reads `notified_at` and returns if it is already
 * set; and the stamp is a conditional `UPDATE ... WHERE notified_at IS NULL`, so
 * two workers racing produce one send. The last one is the only one that holds
 * under concurrency, which is why it is written as a conditional update rather
 * than a read followed by a write.
 *
 * ## The stamp lands before the send, deliberately
 *
 * The two orders trade different failures: stamping first can drop an email if
 * the process dies between the two, and sending first can send the same email
 * repeatedly if it dies the other way round. A lifecycle email is a notice about
 * something that already happened and is visible in the console; a mail loop
 * against a tenant's admins is an incident. So the row is claimed first, and the
 * claim is what a second worker loses.
 *
 * ## Why `SystemPrisma`
 *
 * Both reads are unscoped by necessity. `lifecycle_events` has no
 * `tenant_isolation` policy by design, and the recipient list has to be readable
 * for a tenant that is `cancelled` or being purged — states in which
 * `TenantPrisma` either refuses outright or is about to have its rows deleted.
 * Every statement here names one tenant, by id, taken from the event row.
 */
@Injectable()
export class TenantLifecycleNotifier {
  private readonly logger = new Logger(TenantLifecycleNotifier.name);

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    @Inject(MAILER) private readonly mailer: MailerPort,
  ) {}

  async notify(eventId: string): Promise<void> {
    const event = await this.systemPrisma.lifecycleEvent.findUnique({
      where: { id: eventId },
      select: { id: true, tenantId: true, fromState: true, toState: true, notifiedAt: true },
    });

    if (event === null) {
      throw new LifecycleEventNotFoundError(eventId);
    }

    if (event.notifiedAt !== null) {
      return;
    }

    const template = templateFor(event.fromState, event.toState);

    if (template === null) {
      // Nothing to send, and the row still has to leave the backstop's index —
      // otherwise the sweep re-enqueues a job that does nothing, for ever.
      await this.claim(eventId);

      return;
    }

    if (!(await this.claim(eventId))) {
      // Another worker holds it. Its send is the one that happens.
      return;
    }

    const recipients = await this.recipientsFor(event.tenantId);

    if (recipients.length === 0) {
      this.logger.warn(
        `Tenant ${event.tenantId} reached ${event.toState} with no active admin to tell. ` +
          'Nobody was emailed.',
      );

      return;
    }

    await this.send(template, event.tenantId, recipients);
  }

  /**
   * The three notices that cannot hang off a `lifecycle_events` row, sent
   * directly to the tenant's active admins.
   *
   * `trial_ending` and `deletion_reminder` are **timers rather than
   * transitions** (ADR 0009 decision 7): neither changes a tenant's state, so
   * neither has an event row to be stamped on. The sweep owns their
   * once-only-ness instead, through `tenants.trial_ending_notified_at` and
   * `tenants.deletion_reminder_notified_at`, and claims the stamp before calling
   * this — the same stamp-first order and for the same reason.
   *
   * `tenant_deleted` is here for the opposite reason: it *is* a transition, but
   * it has to be sent **before** the purge rather than after it, because the
   * addresses live in a table the purge destroys. `TenantPurgeService` calls
   * this in the transaction that stamps `purge_started_at`, and a resumed purge
   * does not repeat it because that stamp is what marks the purge begun.
   */
  async remind(
    tenantId: string,
    template: Extract<
      OutboundEmailTemplate,
      'trial_ending' | 'deletion_reminder' | 'tenant_deleted'
    >,
  ): Promise<void> {
    const recipients = await this.recipientsFor(tenantId);

    if (recipients.length === 0) {
      this.logger.warn(
        `Tenant ${tenantId} is owed a ${template} notice and has no active admin to tell.`,
      );

      return;
    }

    await this.send(template, tenantId, recipients);
  }

  /**
   * Reads the addresses a lifecycle email goes to: `users` with `role = 'admin'`
   * and `status = 'active'`.
   *
   * Called **before** the purge for `tenant_deleted`, which is the one case
   * where the order matters — the job is about to destroy the table these
   * addresses live in, so `TenantPurgeService` enqueues the notification in the
   * transaction that stamps `purge_started_at` and this read happens while the
   * rows are still there.
   */
  private async recipientsFor(tenantId: string): Promise<string[]> {
    const admins = await this.systemPrisma.user.findMany({
      where: { tenantId, role: 'admin', status: 'active' },
      select: { email: true },
    });

    return admins.map((admin) => admin.email);
  }

  /**
   * Stamps `notified_at`, and reports whether this caller is the one that got
   * it.
   *
   * A conditional `UPDATE ... WHERE notified_at IS NULL` rather than a read and
   * a write: the window between such a read and its write is exactly the window
   * two workers race in, and the bug it produces is a duplicate email to every
   * admin in the tenant. `updateMany` is used for the `count`, which is the
   * answer — `update` would throw on the row it did not match.
   *
   * The column is the single exception to `lifecycle_events` being append-only:
   * `whatsappcrm_system` holds a **column-level** `GRANT UPDATE ("notified_at")`
   * and the `lifecycle_events_append_only` trigger admits exactly this one
   * change, null → value, once.
   */
  private async claim(eventId: string): Promise<boolean> {
    const { count } = await this.systemPrisma.lifecycleEvent.updateMany({
      where: { id: eventId, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });

    return count > 0;
  }

  /**
   * One message per admin, and a failure to send one does not stop the rest.
   *
   * `Promise.allSettled` rather than `all`: the alternative is that one bad
   * address costs every other admin in the tenant their notice, on the job that
   * tells them their workspace is about to be purged.
   *
   * The row is already stamped by the time this runs, so a total failure here is
   * a logged loss rather than a retry — which is the trade the stamp-first order
   * makes, and the reason the loss is logged loudly enough to act on.
   */
  private async send(
    template: OutboundEmailTemplate,
    tenantId: string,
    recipients: readonly string[],
  ): Promise<void> {
    const results = await Promise.allSettled(
      recipients.map(
        async (to) =>
          // No token and no link path: a lifecycle notice carries no credential,
          // and the console is reached at the tenant's own address, which the
          // adapter already knows how to resolve.
          await this.mailer.send({ to, template, tenantId, data: {} }),
      ),
    );

    const failed = results.filter((result) => result.status === 'rejected').length;

    if (failed > 0) {
      this.logger.error(
        `Could not deliver ${failed} of ${recipients.length} ${template} notices for tenant ` +
          `${tenantId}. The transition itself is committed and recorded.`,
      );
    }
  }
}
