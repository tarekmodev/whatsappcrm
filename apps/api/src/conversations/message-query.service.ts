import { Inject, Injectable } from '@nestjs/common';
import type { CursorPage, MessageListQuery, MessageResponse } from '@whatsappcrm/contracts';
import {
  encodeTimestampCursor,
  readTimestampCursor,
  resumeAfter,
  type TimestampCursor,
} from '../common/pagination/timestamp-keyset';
import { ResponseOriginService } from '../common/response-origin.service';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { ConversationQueryService } from './conversation-query.service';
import { InvalidConversationCursorError } from './conversations.errors';
import { MESSAGE_PROJECTION, toMessageResponse } from './message.mapper';

/**
 * The thread: `GET /api/v1/conversations/{id}/messages`.
 *
 * Sorted by `sent_at` — the **provider's** timestamp, never insert order.
 * Meta does not guarantee delivery order and ingest is concurrent, so a thread
 * ordered by when rows happened to be written shows a customer's two messages
 * the wrong way round often enough to matter.
 *
 * `desc` by default because a thread is read from the newest message backwards,
 * which is also the direction the inbox opens it in. `asc` exists for an
 * export, and it is the direction where a lost row would be least visible —
 * which is why both use the same audited resume predicate rather than a
 * hand-written comparison per branch.
 *
 * ## Cost
 *
 * One statement per page over `messages (tenant_id, conversation_id, sent_at
 * DESC, id DESC)`, plus one batched load of the page's attachments over
 * `message_attachments (tenant_id, message_id)`. `take: limit + 1` answers "is
 * there another page" without counting the highest-volume table in the system.
 *
 * The conversation is required first, which is the visibility check: a thread
 * belonging to a conversation this principal may not see answers `not_found`,
 * not an empty page. An empty page would be a slow way of confirming the id
 * exists.
 */
@Injectable()
export class MessageQueryService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly conversations: ConversationQueryService,
    private readonly origin: ResponseOriginService,
  ) {}

  async list(
    conversationId: string,
    query: MessageListQuery,
  ): Promise<CursorPage<MessageResponse>> {
    await this.conversations.require(conversationId);

    const cursor = readTimestampCursor(query.cursor);

    if (cursor.outcome === 'invalid') {
      throw new InvalidConversationCursorError('cursor');
    }

    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(cursor.outcome === 'cursor' ? resumeFrom(cursor.cursor, query.order) : {}),
      },
      orderBy: [{ sentAt: query.order }, { id: query.order }],
      take: query.limit + 1,
      select: MESSAGE_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const origin = this.origin.require();

    return {
      items: page.map((message) => toMessageResponse(message, origin)),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTimestampCursor({ at: last.sentAt, id: last.id })
          : null,
    };
  }
}

/**
 * The resume predicate 0002 rules, on `sent_at`, in whichever direction the
 * caller asked for. See `timestamp-keyset.ts` for why it is this shape and not
 * the shorter one.
 */
function resumeFrom(cursor: TimestampCursor, order: 'asc' | 'desc'): Prisma.MessageWhereInput {
  const { bound, exclude } = resumeAfter(cursor, order);

  return { sentAt: bound, NOT: { sentAt: cursor.at, ...exclude } };
}
