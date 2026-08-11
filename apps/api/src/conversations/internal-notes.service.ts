import { Inject, Injectable } from '@nestjs/common';
import type {
  CursorPage,
  CursorPageQuery,
  InternalNoteCreateInput,
  InternalNoteResponse,
} from '@whatsappcrm/contracts';
import {
  encodeTimestampCursor,
  readTimestampCursor,
  resumeAfter,
  type TimestampCursor,
} from '../common/pagination/timestamp-keyset';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { UserStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { ConversationQueryService } from './conversation-query.service';
import { InvalidConversationCursorError, UnknownTenantMemberError } from './conversations.errors';

/**
 * Internal notes: what agents say to each other about a thread, and never to the
 * customer.
 *
 * They are a separate entity rather than a message subtype "specifically so that
 * no send path can pick one up by accident — the worst possible bug in this
 * product" (`conversations.ts`). Nothing in this file touches `messages`, and
 * `MessageSendService` does not import it.
 *
 * ## The author is required, and the column is not
 *
 * `InternalNoteResponseSchema.authorUserId` is a non-nullable id;
 * `internal_notes.author_user_id` is nullable, for the system-authored note
 * nothing writes yet. The published shape has no way to represent one, so the
 * list filters them out rather than inventing an id or failing the page. There
 * are none: every note this API creates carries the principal who wrote it, and
 * a removed user keeps their notes because removal is a status change, not a
 * delete. When a workflow (TAR-27) starts writing notes, the contract gains a
 * nullable author in the same change and this filter goes with it — recorded
 * here so the next reader knows it is a bridge, not a rule.
 */

const NOTE_PROJECTION = {
  id: true,
  conversationId: true,
  authorUserId: true,
  body: true,
  mentionedUserIds: true,
  createdAt: true,
} as const satisfies Prisma.InternalNoteSelect;

type NoteRow = Prisma.InternalNoteGetPayload<{ select: typeof NOTE_PROJECTION }>;

@Injectable()
export class InternalNotesService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly conversations: ConversationQueryService,
  ) {}

  /**
   * Newest first, keyset paginated on `(created_at DESC, id DESC)` — served by
   * `internal_notes (tenant_id, conversation_id, created_at DESC, id DESC)`.
   */
  async list(
    conversationId: string,
    query: CursorPageQuery,
  ): Promise<CursorPage<InternalNoteResponse>> {
    await this.conversations.require(conversationId);

    const cursor = readTimestampCursor(query.cursor);

    if (cursor.outcome === 'invalid') {
      throw new InvalidConversationCursorError('cursor');
    }

    const rows = await this.prisma.internalNote.findMany({
      where: {
        conversationId,
        authorUserId: { not: null },
        ...(cursor.outcome === 'cursor' ? resumeFrom(cursor.cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: NOTE_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map(toInternalNoteResponse),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTimestampCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * Writes a note as the caller.
   *
   * The author is the principal, never a field of the request: a note is a
   * statement about who said what, and letting a client name the speaker would
   * make the whole record worthless.
   */
  async create(
    conversationId: string,
    input: InternalNoteCreateInput,
  ): Promise<InternalNoteResponse> {
    await this.conversations.require(conversationId);

    const principal = this.tenantContext.requirePrincipal();
    const mentionedUserIds = await this.resolveMentions(input.mentionedUserIds);

    return toInternalNoteResponse(
      await this.prisma.internalNote.create({
        data: {
          tenantId: principal.tenantId,
          conversationId,
          authorUserId: principal.userId,
          body: input.body,
          mentionedUserIds,
        },
        select: NOTE_PROJECTION,
      }),
    );
  }

  /**
   * Mentions, checked against this tenant and de-duplicated.
   *
   * `mentioned_user_ids` is a plain `uuid[]` with no foreign key, so nothing in
   * the database refuses an id that names nobody — the note would store it, the
   * notification would go nowhere, and the agent who typed it would believe a
   * colleague had been told. Refusing here is what makes the mention mean
   * something.
   *
   * Duplicates are collapsed rather than refused: mentioning somebody twice in
   * one note is a client-side artefact, not an error, and it must not produce
   * two notifications.
   */
  private async resolveMentions(mentionedUserIds: readonly string[]): Promise<string[]> {
    const requested = [...new Set(mentionedUserIds)];

    if (requested.length === 0) {
      return [];
    }

    const found = await this.prisma.user.findMany({
      where: { id: { in: requested }, status: UserStatus.active },
      select: { id: true },
    });
    const known = new Set(found.map((user) => user.id));
    const missing = requested.find((id) => !known.has(id));

    if (missing !== undefined) {
      throw new UnknownTenantMemberError('mentionedUserIds', 'user', missing);
    }

    return requested;
  }
}

function toInternalNoteResponse(note: NoteRow): InternalNoteResponse {
  if (note.authorUserId === null) {
    // Unreachable: the list filters these out and the create path sets the
    // principal. Loud rather than `?? ''`, which would publish an id that fails
    // the contract's own schema and look like a bug in the client.
    throw new Error(
      `Internal note ${note.id} has no author, which the published shape cannot express.`,
    );
  }

  return {
    id: note.id,
    conversationId: note.conversationId,
    authorUserId: note.authorUserId,
    body: note.body,
    mentionedUserIds: note.mentionedUserIds,
    createdAt: note.createdAt.toISOString(),
  };
}

/** The resume predicate 0002 rules, on `created_at`. See `timestamp-keyset.ts`. */
function resumeFrom(cursor: TimestampCursor): Prisma.InternalNoteWhereInput {
  const { bound, exclude } = resumeAfter(cursor, 'desc');

  return { createdAt: bound, NOT: { createdAt: cursor.at, ...exclude } };
}
