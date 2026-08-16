import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ResponseOriginService } from '../common/response-origin.service';
import { ConversationsModule } from '../conversations/conversations.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AiConfigController } from './ai-config.controller';
import { AiConfigService } from './ai-config.service';
import { AiQueueRunner } from './ai-queue.runner';
import { BotEligibilityService } from './bot-eligibility.service';
import { BotTurnService } from './bot-turn.service';
import { ClaudeClient } from './claude.client';
import { HandoffController } from './handoff.controller';
import { HandoffService } from './handoff.service';
import { KnowledgeDocumentService } from './knowledge-document.service';
import { KnowledgeDocumentsController } from './knowledge-documents.controller';
import { KnowledgeIndexerService } from './knowledge-indexer.service';
import { KnowledgeRetrieverService } from './knowledge-retriever.service';

/**
 * The AI chatbot: knowledge base, confidence gating and human handoff (TAR-28),
 * built against
 * `docs/architecture/0010-ai-chatbot-knowledge-base-and-handoff.md`.
 *
 * An **L4 module** per 0002's table. It may import L3 domain modules; nothing
 * below it may import it — which is exactly why the trigger reaching it is a
 * queue job rather than a call. `TicketsModule` needs to tell it an inbound
 * message was linked and may not name it, so what crosses the line is the shape
 * in `@whatsappcrm/contracts/ai` and the `ai` queue.
 *
 * ## What it imports, and why each one
 *
 *   * `ConversationsModule` for `AutomatedMessageSender` — the send path for a
 *     message nobody typed. The bot writes ordinary `messages` rows through the
 *     module that owns them rather than reproducing that transaction here.
 *   * `EntitlementsModule` for `PlanFeaturesService`, the `ai_chatbot` gate.
 *
 * Everything else comes from global modules: `TenantPrisma` from `PrismaModule`,
 * `TenantContextService` from `TenantContextModule`, `QueueService` from
 * `QueueModule`, `ConfigService` from the root `ConfigModule`, and `EventEmitter2`
 * from the root `EventEmitterModule`.
 *
 * **No `SystemPrisma` anywhere in this story**, and none is needed: every entry
 * point is either an authenticated request or a job payload carrying a tenant
 * id, so there is no across-tenants read to justify a sixth call site.
 *
 * It exports nothing. Its whole public surface is three HTTP controllers and one
 * queue.
 *
 * | Provider                    | Responsibility                                                            |
 * | --------------------------- | ------------------------------------------------------------------------- |
 * | `KnowledgeDocumentService`  | The knowledge-base CRUD surface, and enqueuing indexing                   |
 * | `KnowledgeIndexerService`   | Chunking, delete-and-insert in one transaction                            |
 * | `KnowledgeRetrieverService` | The FTS + trigram query, top-K selection and the retrieval score          |
 * | `AiConfigService`           | The per-tenant configuration and the readiness breakdown                  |
 * | `BotEligibilityService`     | The gate — the empty-knowledge-base rule and every silent refusal         |
 * | `ClaudeClient`              | The provider wrapper. The one class that names a model vendor             |
 * | `BotTurnService`            | One turn: gate → keyword → retrieve → model → score → send-or-handoff     |
 * | `HandoffService`            | The handoff event, the state move, routing, and the "full context" DTO    |
 * | `AiQueueRunner`             | BullMQ registration — the only file here that knows a queue exists        |
 *
 * `ResponseOriginService` is declared rather than imported, on the precedent
 * `ConversationsModule` sets: it is a stateless reader of the request scope, and
 * the handoff DTO needs one to make attachment paths absolute.
 */
@Module({
  imports: [ConversationsModule, EntitlementsModule],
  controllers: [KnowledgeDocumentsController, AiConfigController, HandoffController],
  providers: [
    KnowledgeDocumentService,
    KnowledgeIndexerService,
    KnowledgeRetrieverService,
    AiConfigService,
    BotEligibilityService,
    ClaudeClient,
    BotTurnService,
    HandoffService,
    AiQueueRunner,
    ResponseOriginService,
    ApiExceptionFilter,
  ],
})
export class AiModule {}
