import { Inject, Injectable } from '@nestjs/common';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import type { RoutedWhatsAppAccount } from './whatsapp-inbound.writer';

/**
 * `phone_number_id` → the tenant that owns the number.
 *
 * This is the routing step the whole ingestion design turns on. One Meta app
 * serves every tenant, so nothing about an inbound delivery names a tenant
 * except the number it arrived on — which is why `whatsapp_accounts.phone_number_id`
 * is unique **globally** rather than per tenant (TAR-39, webhook ingestion).
 *
 * It reads across tenants, so it is one of the five `SystemPrisma` call sites
 * TAR-39 permits, and it is a class of its own precisely so that use is visible
 * in a grep for `SYSTEM_PRISMA` rather than buried in a processor.
 *
 * Nothing is cached. The lookup is a single-row hit on a unique index, once per
 * webhook batch rather than once per message, and a cache would have to be
 * invalidated when a number is connected or moved — the moment when getting it
 * wrong routes a customer's message into another tenant's inbox.
 */
@Injectable()
export class WhatsAppAccountResolver {
  constructor(@Inject(SYSTEM_PRISMA) private readonly prisma: SystemPrisma) {}

  /** `null` when no tenant has connected this number — the caller parks the event. */
  async resolve(phoneNumberId: string): Promise<RoutedWhatsAppAccount | null> {
    const account = await this.prisma.whatsappAccount.findUnique({
      where: { phoneNumberId },
      select: { id: true, tenantId: true },
    });

    return account === null ? null : { tenantId: account.tenantId, whatsappAccountId: account.id };
  }
}
