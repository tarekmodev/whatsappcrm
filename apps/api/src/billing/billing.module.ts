import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BILLING_PROVIDER, type BillingProvider } from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { BillingController } from './billing.controller';
import { BillingEventProcessor } from './billing-event.processor';
import { BillingQueueRunner } from './billing-queue.runner';
import { BillingReaderService } from './billing-reader.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { BillingSweeperService } from './billing-sweeper.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingWebhookService } from './billing-webhook.service';
import { CheckoutService } from './checkout.service';
import { FakeBillingProvider } from './providers/fake/fake-billing.provider';
import { PolarBillingProvider } from './providers/polar/polar-billing.provider';
import { SeatSyncService } from './seat-sync.service';
import { SubscriptionSyncService } from './subscription-sync.service';
import { VolumeNotifierService } from './volume-notifier.service';

/**
 * Subscription billing (TAR-37), built against the billing contract published on
 * TAR-616 and the schema landed by TAR-617.
 *
 * ## The provider is bound once, here, and nowhere else
 *
 * `BILLING_PROVIDER` resolves to `PolarBillingProvider` or `FakeBillingProvider`
 * according to `BILLING_PROVIDER_DRIVER`, which defaults to `fake`. Every other
 * class in the module injects the token and none of them can tell which is
 * behind it — that is the seam the contract's first goal names, and it is what
 * lets the whole flow be exercised with no Polar account.
 *
 * A factory rather than two modules or a conditional import, because the
 * decision is a *value* read at boot: `useFactory` is the only shape where the
 * choice is visible in one place and testable by overriding one token.
 *
 * ## An L3 module
 *
 * It imports platform modules below it and no feature module beside it:
 *
 * | Import              | For                                                         |
 * | ------------------- | ----------------------------------------------------------- |
 * | `EntitlementsModule`| the seat and volume counts the panel and checkout read       |
 * | `IdempotencyModule` | the `Idempotency-Key` on checkout                           |
 * | `IdentityModule`    | the mailer, and the host resolver return URLs are composed from |
 * | `TenancyModule`     | `TenantLifecycleService` — the seam dunning runs through      |
 * | `WebhooksModule`    | `WebhookEventsRepository` — the one store-then-enqueue table |
 *
 * Nothing imports **this** module, and that is deliberate: the two paths that
 * feed it — a membership change and a conversation being opened — reach it
 * through the in-process domain bus, so `IdentityModule`, `PeopleModule` and
 * `WebhooksModule` stay free of any knowledge that billing exists. What crosses
 * those boundaries is a type in `events/domain-events.ts`, not a class.
 *
 * ## What it exports
 *
 * Nothing. Its whole public surface is two HTTP controllers, a queue worker and
 * two event subscribers.
 */
@Module({
  imports: [EntitlementsModule, IdempotencyModule, IdentityModule, TenancyModule, WebhooksModule],
  controllers: [BillingController, BillingWebhookController],
  providers: [
    {
      provide: BILLING_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): BillingProvider =>
        config.getOrThrow<'polar' | 'fake'>('BILLING_PROVIDER_DRIVER') === 'polar'
          ? new PolarBillingProvider(config)
          : new FakeBillingProvider(config),
    },
    BillingReaderService,
    CheckoutService,
    SubscriptionSyncService,
    SeatSyncService,
    VolumeNotifierService,
    BillingWebhookService,
    BillingEventProcessor,
    BillingSweeperService,
    BillingReconciliationService,
    BillingQueueRunner,
    ApiExceptionFilter,
  ],
})
export class BillingModule {}
