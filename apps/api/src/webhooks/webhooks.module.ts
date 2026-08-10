import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
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
 */
@Module({
  controllers: [WhatsAppWebhookController],
  providers: [
    WebhookEventsRepository,
    WebhookIngestService,
    WebhookQueueRunner,
    WebhookSweeperService,
    WhatsAppAccountResolver,
    WhatsAppEventProcessor,
    WhatsAppInboundWriter,
    ApiExceptionFilter,
  ],
})
export class WebhooksModule {}
