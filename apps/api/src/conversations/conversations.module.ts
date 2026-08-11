import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { ResponseOriginService } from '../common/response-origin.service';
import { MediaModule } from '../media/media.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { ConversationCommandService } from './conversation-command.service';
import { ConversationQueryService } from './conversation-query.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsQueueRunner } from './conversations-queue.runner';
import { InternalNotesService } from './internal-notes.service';
import { MessageQueryService } from './message-query.service';
import { MessageSendService } from './message-send.service';
import { OutboundMessageDispatcher } from './outbound-message.dispatcher';

/**
 * The shared inbox: conversations, their threads, their notes, and the send
 * path (TAR-20, TAR-39 module map).
 *
 * ## Layering
 *
 * An **L3 domain module**. It imports the two access modules below it and no
 * module beside or above it:
 *
 *   * `WhatsAppModule` for `WhatsAppSenderService` — the send path — and
 *     `MessageTemplateQueryService`, which is what lets the endpoint refuse an
 *     unapproved template before the Cloud API is called. No access token
 *     reaches this module; `WhatsAppCredentialResolver` stays private to the one
 *     that owns it.
 *   * `MediaModule` for `MediaSendResolver`, which turns one of our media ids
 *     into a handle Meta holds. This module never reaches the object store or
 *     the `media_objects` table itself.
 *
 * It does not import `TicketsModule` or `WebhooksModule`, and neither imports
 * it. What crosses those lines is a shape — the ticket-linking contract, a
 * domain event, a queue job — which both sides depend on and neither owns.
 *
 * ## What is not here
 *
 * The realtime relay. `MESSAGE_CREATED_EVENT` and `MESSAGE_STATUS_CHANGED_EVENT`
 * are emitted from the send path and the delivery worker, and
 * `CONVERSATION_ASSIGNED_EVENT` from the claim endpoint (TAR-198), all onto the
 * in-process bus; TAR-20d subscribes to them and owns the socket. A gateway
 * declared here would make the inbox depend on a transport it does not need in
 * order to record a message or hand a thread over.
 *
 * `ResponseOriginService` is declared rather than imported: it is a stateless
 * reader of the request scope, and the second module that needs one — the
 * realtime relay, which has to make the same attachment paths absolute — should
 * declare it too rather than import this module for it.
 *
 * Everything else comes from global modules: `TenantPrisma` from `PrismaModule`,
 * `TenantContextService` from `TenantContextModule`, `QueueService` from
 * `QueueModule`, `EventEmitter2` from the root `EventEmitterModule`.
 */
@Module({
  imports: [WhatsAppModule, MediaModule, IdempotencyModule],
  controllers: [ConversationsController],
  providers: [
    ConversationQueryService,
    ConversationCommandService,
    MessageQueryService,
    MessageSendService,
    InternalNotesService,
    OutboundMessageDispatcher,
    ConversationsQueueRunner,
    ResponseOriginService,
    ApiExceptionFilter,
  ],
})
export class ConversationsModule {}
