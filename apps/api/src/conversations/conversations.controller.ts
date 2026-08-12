import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  ConversationAssignInputSchema,
  ConversationListQuerySchema,
  ConversationStatusUpdateInputSchema,
  CursorPageQuerySchema,
  IdSchema,
  InternalNoteCreateInputSchema,
  MessageListQuerySchema,
  SendMessageInputSchema,
  type ConversationAssignInput,
  type ConversationListQuery,
  type ConversationResponse,
  type ConversationStatusUpdateInput,
  type CursorPage,
  type CursorPageQuery,
  type InternalNoteCreateInput,
  type InternalNoteResponse,
  type MessageListQuery,
  type MessageResponse,
  type SendMessageInput,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { ConversationCommandService } from './conversation-command.service';
import { ConversationQueryService } from './conversation-query.service';
import { translateConversationFailure } from './conversations.http';
import { InternalNotesService } from './internal-notes.service';
import { MessageQueryService } from './message-query.service';
import { MessageSendService } from './message-send.service';

/** Lower-case, because Express lower-cases every header name it indexes. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * The shared inbox (TAR-20, TAR-39 endpoint table).
 *
 * It declares no guards. `RequestPipelineModule` runs all three on every route
 * in the application (TAR-58) — where the request is, who is making it, then
 * whether they may — so every route below states only its permission.
 *
 * ## The permissions, and the one the endpoint table does not name
 *
 * 0002 names three: `conversation:read` on the list, `conversation:assign` on
 * the claim, `conversation:send` on the send, `conversation:note` on a note. It
 * names none for the detail read, the status change, the read receipt or the
 * thread, and `PermissionGuard` refuses a route that declares nothing — so each
 * of those has to pick one, and every one of them picks `conversation:read`.
 *
 * That is a decision worth stating rather than a default. Resolving a
 * conversation and marking it read are things the agent handling it does dozens
 * of times an hour, and the matrix has no `conversation:update` to ask for; the
 * three roles that hold `conversation:read` are exactly the three that should be
 * able to. What bounds them is not the permission but the **visibility** check
 * every one of these routes makes: a thread the caller may not see answers
 * `not_found`, whatever their role.
 *
 * ## Reading the shared pool is open; writing into it is not
 *
 * A tenth route joins them in TAR-186: `POST /conversations/{id}/claim`, on a
 * `conversation:claim` every role holds. It exists because an unclaimed
 * conversation is visible to every agent, so without an owner two of them reply
 * to the same customer. The send, the note and the status change therefore
 * refuse a thread nobody holds — `ConversationQueryService.requireHeld` — and
 * claiming is the action that clears that. The list, the detail read, the
 * message history and the read receipt are unchanged.
 *
 * ## Ids are validated as UUIDs before anything looks them up
 *
 * A path parameter that is not a UUID names nothing, and it reaches a `@db.Uuid`
 * column as a driver error rather than a filter — a 500 for input that deserves
 * a 400.
 */
@Controller({ path: 'conversations', version: '1' })
@UseFilters(ApiExceptionFilter)
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationQueryService,
    private readonly commands: ConversationCommandService,
    private readonly messages: MessageQueryService,
    private readonly sends: MessageSendService,
    private readonly notes: InternalNotesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** `GET /api/v1/conversations` — the inbox list. */
  @Get()
  @RequirePermission('conversation:read')
  list(
    @Query(new ZodValidationPipe(ConversationListQuerySchema)) query: ConversationListQuery,
  ): Promise<CursorPage<ConversationResponse>> {
    return this.conversations.list(query).catch(translateConversationFailure);
  }

  @Get(':id')
  @RequirePermission('conversation:read')
  get(@Param('id', conversationIdPipe()) id: string): Promise<ConversationResponse> {
    return this.conversations.get(id).catch(translateConversationFailure);
  }

  @Patch(':id/status')
  @RequirePermission('conversation:read')
  setStatus(
    @Param('id', conversationIdPipe()) id: string,
    @Body(new ZodValidationPipe(ConversationStatusUpdateInputSchema))
    input: ConversationStatusUpdateInput,
  ): Promise<ConversationResponse> {
    return this.commands.setStatus(id, input.status).catch(translateConversationFailure);
  }

  /**
   * `POST /api/v1/conversations/{id}/claim` — take a thread nobody holds.
   *
   * Separate from `assign` because it is a narrower act with a wider audience:
   * every role holds `conversation:claim`, it can only ever move a conversation
   * from unassigned to the caller, and it can never take one off the colleague
   * working it. `assign` keeps the rest — routing to a team, handing to a named
   * agent, releasing back to the pool — and stays supervisor and above.
   *
   * No body: the assignee is the session's principal, never a parameter. A claim
   * that could name somebody else would be a re-assignment wearing this
   * permission.
   *
   * No `Idempotency-Key` either. The write is a compare-and-set the caller
   * cannot repeat into a second effect — a replay by the holder answers 200 with
   * the same conversation — so the header would guard nothing.
   */
  @Post(':id/claim')
  @RequirePermission('conversation:claim')
  @HttpCode(HttpStatus.OK)
  claim(@Param('id', conversationIdPipe()) id: string): Promise<ConversationResponse> {
    return this.commands.claim(id).catch(translateConversationFailure);
  }

  /** `POST /api/v1/conversations/{id}/assign` — route to a team, hand over, or release. */
  @Post(':id/assign')
  @RequirePermission('conversation:assign')
  @HttpCode(HttpStatus.OK)
  assign(
    @Param('id', conversationIdPipe()) id: string,
    @Body(new ZodValidationPipe(ConversationAssignInputSchema)) input: ConversationAssignInput,
  ): Promise<ConversationResponse> {
    return this.commands.assign(id, input).catch(translateConversationFailure);
  }

  /** `POST /api/v1/conversations/{id}/read` — 204, and idempotent. */
  @Post(':id/read')
  @RequirePermission('conversation:read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(@Param('id', conversationIdPipe()) id: string): Promise<void> {
    await this.commands.markRead(id).catch(translateConversationFailure);
  }

  @Get(':id/messages')
  @RequirePermission('conversation:read')
  listMessages(
    @Param('id', conversationIdPipe()) id: string,
    @Query(new ZodValidationPipe(MessageListQuerySchema)) query: MessageListQuery,
  ): Promise<CursorPage<MessageResponse>> {
    return this.messages.list(id, query).catch(translateConversationFailure);
  }

  /**
   * `POST /api/v1/conversations/{id}/messages` — the send.
   *
   * `Idempotency-Key` is **required**, per 0002: this is a POST with an external
   * side effect, and without the header an agent double-clicking Send during a
   * slow Meta call sends the customer two messages. A missing or malformed key
   * is refused before anything is looked up.
   *
   * 201 on both a first execution and a replay. The stored status code is the
   * same by construction — one endpoint, one success status — so reading it back
   * off the stored row and setting it through `@Res()` would give up Nest's
   * serialisation to reproduce a constant.
   */
  @Post(':id/messages')
  @RequirePermission('conversation:send')
  @HttpCode(HttpStatus.CREATED)
  async send(
    @Param('id', conversationIdPipe()) id: string,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(SendMessageInputSchema)) input: SendMessageInput,
  ): Promise<MessageResponse> {
    const key = requireIdempotencyKey(idempotencyKey);

    const outcome = await this.idempotency
      .execute<MessageResponse>(
        {
          key,
          operation: 'conversation.send',
          target: id,
          payload: input,
          statusCode: HttpStatus.CREATED,
        },
        async () => await this.sends.send(id, input),
      )
      .catch(translateConversationFailure);

    return outcome.body;
  }

  @Get(':id/notes')
  @RequirePermission('conversation:read')
  listNotes(
    @Param('id', conversationIdPipe()) id: string,
    @Query(new ZodValidationPipe(CursorPageQuerySchema)) query: CursorPageQuery,
  ): Promise<CursorPage<InternalNoteResponse>> {
    return this.notes.list(id, query).catch(translateConversationFailure);
  }

  /**
   * `POST /api/v1/conversations/{id}/notes` — a note the customer never sees.
   *
   * No `Idempotency-Key`: a note has no external side effect, and a duplicate is
   * something an agent can delete rather than a second message to a customer.
   * 0002 requires the header on sends and billing operations, and nothing else.
   */
  @Post(':id/notes')
  @RequirePermission('conversation:note')
  @HttpCode(HttpStatus.CREATED)
  createNote(
    @Param('id', conversationIdPipe()) id: string,
    @Body(new ZodValidationPipe(InternalNoteCreateInputSchema)) input: InternalNoteCreateInput,
  ): Promise<InternalNoteResponse> {
    return this.notes.create(id, input).catch(translateConversationFailure);
  }
}

function conversationIdPipe(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new ApiException('validation_failed', 'The conversation id must be a UUID.', [
        { path: 'id', message: 'Must be a UUID.' },
      ]),
  });
}

/**
 * The header, as a client-generated UUID.
 *
 * Required rather than optional, and shaped rather than merely present: a key
 * that is not globally unique is a key that collides with another agent's, and
 * `(tenant_id, key)` would then replay somebody else's response. A UUID is what
 * 0002 specifies and what makes that collision negligible.
 */
function requireIdempotencyKey(value: string | undefined): string {
  const parsed = IdSchema.safeParse(value);

  if (!parsed.success) {
    throw new ApiException(
      'validation_failed',
      'This request requires an Idempotency-Key header carrying a client-generated UUID.',
      [{ path: 'Idempotency-Key', message: 'Must be a UUID.' }],
    );
  }

  return parsed.data;
}
