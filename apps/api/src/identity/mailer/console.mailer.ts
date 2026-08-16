import { Injectable, Logger } from '@nestjs/common';
import type { MailerPort, OutboundEmail } from './mailer.port';
import { TenantLinkService } from './tenant-link.service';

/**
 * The development adapter: renders the email to the log instead of sending it,
 * so invite and reset flows are testable end to end with no vendor account —
 * the same shape `FakeBillingProvider` gives TAR-37.
 *
 * ⚠️ **It logs a live credential.** The rendered link carries the reset token,
 * which is the whole point locally and would be a disclosed credential in a
 * production log aggregator. `IdentityModule` is what keeps that from happening:
 * this adapter is bound only outside production, and a deployed environment gets
 * `UndeliverableMailer` until TAR-41 wires a real provider (TAR-53, open
 * question 2). Do not bind it by hand.
 */
@Injectable()
export class ConsoleMailer implements MailerPort {
  private readonly logger = new Logger(ConsoleMailer.name);

  constructor(private readonly links: TenantLinkService) {}

  async send(message: OutboundEmail): Promise<void> {
    const link = await this.renderLink(message);

    this.logger.log(
      `[email:${message.template}] to=${message.to} tenant=${message.tenantId ?? 'none'}` +
        (link === null ? '' : ` link=${link}`),
    );
  }

  /**
   * Templates that carry no link — `password_changed`, `account_locked` — return
   * `null` and are logged as a notification, which is what they are.
   */
  private async renderLink(message: OutboundEmail): Promise<string | null> {
    const { linkPath, token } = message.data;

    if (linkPath === undefined || token === undefined) {
      return null;
    }

    if (message.tenantId === null) {
      // No tenant to resolve a hostname for, and none to warn about: the message
      // is self-signup's, and its link is what creates the tenant (TAR-405).
      return this.links.platformLink(linkPath, token);
    }

    const link = await this.links.absoluteLink(linkPath, token);

    if (link === null) {
      this.logger.warn(
        `Tenant ${message.tenantId} has no verified domain, so the ${message.template} link ` +
          'cannot be addressed. Provision a platform subdomain for it.',
      );
    }

    return link;
  }
}

/**
 * The deployed-environment adapter until a provider is chosen (TAR-53, open
 * question 2, owned by TAR-41).
 *
 * It drops the message and says so, loudly and without the token. That is worse
 * for a user than a working mailer and better than the two alternatives: writing
 * live reset links into a production log, or failing the request — a reset
 * request that returns 500 tells an unauthenticated caller their email address
 * exists, which is exactly the enumeration oracle the unconditional 204 exists
 * to close.
 */
@Injectable()
export class UndeliverableMailer implements MailerPort {
  private readonly logger = new Logger(UndeliverableMailer.name);

  send(message: OutboundEmail): Promise<void> {
    this.logger.error(
      `No transactional email provider is configured: dropped a ${message.template} message for ` +
        `tenant ${message.tenantId}. TAR-41 must wire an adapter behind the MAILER token.`,
    );

    return Promise.resolve();
  }
}
