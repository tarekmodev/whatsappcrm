import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseFilters } from '@nestjs/common';
import {
  RequestHandoffInputSchema,
  type ConversationResponse,
  type HandoffContextResponse,
  type RequestHandoffInput,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { translateAiFailure } from './ai.http';
import { HandoffService } from './handoff.service';

/**
 * The two handoff routes, which hang off a conversation rather than off `/ai`
 * (TAR-28 AC2, 0010's endpoint surface).
 *
 * ## Why they live in `AiModule` and not `ConversationsModule`
 *
 * The path is `/conversations/{id}/handoff`, because that is the resource an
 * agent is looking at — but everything behind it is this story's:
 * `handoff_events`, `bot_turns`, the cited knowledge-base documents. Putting the
 * routes here keeps `ConversationsModule` (L3) free of any knowledge of the bot,
 * which is the whole reason `AiModule` is L4. Nest maps a controller by its
 * declared path, not by its module, so the URL is unaffected.
 *
 * ## The permissions
 *
 * The read is `conversation:read`, because it publishes messages from a thread
 * and must be readable by exactly the people who can already open that thread —
 * `HandoffService` applies the module's own visibility check on top, so a
 * conversation the principal may not see answers `not_found` either way.
 *
 * The write is `conversation:claim`: taking a thread from the bot is the same
 * act as taking one out of the shared pool, and every role holds it.
 */
@Controller({ path: 'conversations', version: '1' })
@UseFilters(ApiExceptionFilter)
export class HandoffController {
  constructor(private readonly handoffs: HandoffService) {}

  /** The most recent handoff, or `404` when the conversation has never had one. */
  @Get(':id/handoff')
  @RequirePermission('conversation:read')
  get(@Param('id', conversationIdPipe()) id: string): Promise<HandoffContextResponse> {
    return this.handoffs.context(id).catch(translateAiFailure);
  }

  /**
   * An agent taking a bot-active thread. **Idempotent**: a conversation already
   * released, or one the bot never touched, answers 200 with the current
   * resource and writes nothing.
   *
   * The body is empty and `.strict()`, so a client that sends a `reason` is told
   * so rather than having it silently ignored — the reason is always
   * `agent_requested`.
   */
  @Post(':id/handoff')
  @RequirePermission('conversation:claim')
  request(
    @Param('id', conversationIdPipe()) id: string,
    @Body(new ZodValidationPipe(RequestHandoffInputSchema)) body: RequestHandoffInput,
  ): Promise<ConversationResponse> {
    // Bound only so the pipe runs: the schema is `.strict()`, so a client that
    // invents a field is refused rather than having it silently dropped. There
    // is nothing in the body to pass on — the reason is always
    // `agent_requested`.
    void body;

    return this.handoffs.requestFromAgent(id).catch(translateAiFailure);
  }
}

/**
 * A path parameter that is not a UUID names nothing, and it reaches a `@db.Uuid`
 * column as a driver error rather than a filter — a 500 for input that deserves
 * a 400.
 */
function conversationIdPipe(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new ApiException('validation_failed', 'The conversation id must be a UUID.', [
        { path: 'id', message: 'Must be a UUID.' },
      ]),
  });
}
