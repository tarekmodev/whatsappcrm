import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { PlatformAdminGuard } from '../tenancy/admin/platform-admin.guard';
import { AdminWebhookEventsController } from './admin/admin-webhook-events.controller';
import { WebhookEventReplayService } from './admin/webhook-event-replay.service';
import { WebhookEventsRepository } from './webhook-events.repository';
import { WebhookIngestService } from './webhook-ingest.service';
import { WebhookQueueRunner } from './webhook-queue.runner';
import { WebhookSweeperService } from './webhook-sweeper.service';
import { WhatsAppAccountResolver } from './whatsapp-account.resolver';
import { WhatsAppEventProcessor } from './whatsapp-event.processor';
import { WhatsAppInboundWriter } from './whatsapp-inbound.writer';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';

/**
 * Ingest controllers and processors for inbound provider events (TAR-39, module
 * map). WhatsApp lands here with TAR-20; the billing webhook joins it with
 * TAR-37, sharing the same store-then-enqueue shape and the same sweeper.
 *
 * An **L2 access module**: it may import platform modules below it and nothing
 * beside or above it. It notably does **not** import `ConversationsModule` or
 * `TicketsModule` — those are L3, and reaching up would invert the layering the
 * whole architecture rests on. What crosses that line is a domain event
 * (`message.created`), which TAR-20d's realtime gateway subscribes to.
 *
 * Everything it needs comes from global modules: `QueueService` from
 * `QueueModule`, both Prisma clients from `PrismaModule`, `TenantContextService`
 * from `TenantContextModule`, and `EventEmitter2` from the root
 * `EventEmitterModule`. Nothing is exported — this module is driven by Meta and
 * by its own queue, never called by another module.
 *
 * Since TAR-94 it is driven by one more thing: a platform operator, on
 * `AdminWebhookEventsController`. That surface lives here rather than in
 * `tenancy/admin/` because what it acts on is this module's table and this
 * module's recovery path, and it reaches that table the same way everything else
 * here does — through `WebhookEventsRepository`, so the `SystemPrisma` exception
 * stays confined to the one class. `PlatformAdminGuard` is declared rather than
 * imported, following `WhatsAppModule`: it is a stateless guard, so a second
 * instance costs nothing, and declaring it keeps the authentication decision
 * visible in this module's own provider list.
 */
@Module({
  // `EntitlementsModule` for the usage counter. Ingest meters conversations
  // opened; it reads no limit and refuses nothing — a customer's message is
  // stored whatever the plan says (TAR-405).
  imports: [EntitlementsModule],
  controllers: [WhatsAppWebhookController, AdminWebhookEventsController],
  providers: [
    WebhookEventsRepository,
    WebhookIngestService,
    WebhookQueueRunner,
    WebhookSweeperService,
    WebhookEventReplayService,
    WhatsAppAccountResolver,
    WhatsAppEventProcessor,
    WhatsAppInboundWriter,
    PlatformAdminGuard,
    ApiExceptionFilter,
  ],
  // The one export, and it is the point of the class it names: `webhook_events`
  // is the platform's single store-then-enqueue table, and TAR-37's billing
  // ingest lands in it under `provider = 'billing'` rather than growing a second
  // table with a second sweeper and a second place for a stuck row to hide.
  // Exporting the repository is what keeps the `SystemPrisma` exception confined
  // to one class — `BillingModule` reaches the table through this and never
  // injects `SYSTEM_PRISMA` for it.
  exports: [WebhookEventsRepository],
})
export class WebhooksModule {}
