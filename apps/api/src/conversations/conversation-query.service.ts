import { Inject, Injectable } from '@nestjs/common';
import type {
  ConversationListQuery,
  ConversationResponse,
  ConversationSort,
  CursorPage,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  encodeTimestampCursor,
  readTimestampCursor,
  resumeAfter,
  type TimestampCursor,
} from '../common/pagination/timestamp-keyset';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { isUnclaimed, isVisibleOrUnclaimed } from '../rbac/visibility';
import {
  CONVERSATION_PROJECTION,
  toConversationResponse,
  type ConversationRow,
} from './conversation.mapper';
import {
  ConversationNotFoundError,
  ConversationUnclaimedError,
  InvalidConversationCursorError,
} from './conversations.errors';
import { inboxScopeFilter } from './inbox-scope';

/**
 * The inbox reads: the list, and one thread's header.
 *
 * ## Isolation
 *
 * Every statement runs on `TenantPrisma`, so `app.tenant_id` is set and TAR-48's
 * RLS supplies the tenant equality. There is no `tenantId` parameter anywhere in
 * this file, which is what makes "no cross-tenant read" a property of the wiring
 * rather than of remembering a filter. What this service adds on top is the
 * *intra*-tenant question RLS cannot answer: which of this tenant's
 * conversations may this principal see.
 *
 * ## The list is the hottest query in the product
 *
 * It sorts `(last_message_at, id)` and pages by keyset, served by the three
 * indexes TAR-80 added: the tenant-wide
 * `(tenant_id, status, last_message_at DESC, id DESC)` when the principal holds
 * `conversation:read_all`, and the two scope indexes carrying the same sort key
 * otherwise. `take: limit + 1` decides whether there is another page, so no
 * request pays for a `count(*)` over a table that is appended to continuously.
 *
 * `sort` (TAR-517) flips that one direction and nothing else. A btree scans
 * backwards at the same cost, so `oldest` is served by the same three indexes —
 * no migration, no second index — and the keyset predicate mirrors with it,
 * which `timestamp-keyset.ts` already supports for the thread's export order.
 *
 * ## What each row costs
 *
 * One statement for the page, plus the relation loads
 * `CONVERSATION_PROJECTION` declares — the contact and its tags, the newest
 * message, the active ticket. Prisma batches each of those into **one** query
 * over the page rather than one per row, and each is served by an existing
 * index. The honest cost is therefore four round trips for a 25-row page, not
 * an N+1; the alternative — denormalising the preview and the ticket id onto
 * `conversations` — is recorded as the measurement-first follow-up in
 * `conversation.mapper.ts`.
 *
 * `q` is the one filter with no index behind it: it matches the contact's
 * display name or phone number with a case-insensitive `contains`, which is a
 * scan of the tenant's contacts. Acceptable at the sizes this product has, and
 * a trigram index on `contacts` is the fix when it is not — stated rather than
 * left to be discovered under load.
 */
@Injectable()
export class ConversationQueryService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(query: ConversationListQuery): Promise<CursorPage<ConversationResponse>> {
    const principal = this.tenantContext.requirePrincipal();
    const cursor = readTimestampCursor(query.cursor);

    if (cursor.outcome === 'invalid') {
      throw new InvalidConversationCursorError('cursor');
    }

    const scope = inboxScopeFilter(query.scope, principal);
    const direction = SORT_DIRECTIONS[query.sort];

    const rows = await this.prisma.conversation.findMany({
      where: {
        ...(query.status === undefined ? {} : { status: query.status }),
        // The requested assignee narrows the scope; it never widens it. Both are
        // plain keys on the same `where`, so Prisma conjoins them.
        ...(query.assignedUserId === undefined ? {} : { assignedUserId: query.assignedUserId }),
        ...(query.assignedTeamId === undefined ? {} : { assignedTeamId: query.assignedTeamId }),
        ...(query.q === undefined ? {} : { contact: contactSearch(query.q) }),
        ...(scope === null ? {} : { AND: [scope] }),
        ...(cursor.outcome === 'cursor' ? resumeFrom(cursor.cursor, direction) : {}),
      },
      orderBy: [{ lastMessageAt: direction }, { id: direction }],
      take: query.limit + 1,
      select: CONVERSATION_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map(toConversationResponse),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTimestampCursor({ at: last.lastMessageAt, id: last.id })
          : null,
    };
  }

  /** One thread's header, as `GET /api/v1/conversations/{id}` publishes it. */
  async get(conversationId: string): Promise<ConversationResponse> {
    return toConversationResponse(await this.require(conversationId));
  }

  /**
   * The row, or `ConversationNotFoundError` — for an id that does not exist, one
   * in another tenant, and one this principal may not see. The three are
   * deliberately indistinguishable; see the error's own comment.
   *
   * Shared by every route in this module that addresses a single conversation,
   * so the visibility check cannot be the thing one of them forgets.
   */
  async require(conversationId: string): Promise<ConversationRow> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: CONVERSATION_PROJECTION,
    });

    if (
      conversation === null ||
      !isVisibleOrUnclaimed(
        conversation,
        this.tenantContext.requirePrincipal(),
        'conversation:read_all',
      )
    ) {
      throw new ConversationNotFoundError(conversationId);
    }

    return conversation;
  }

  /**
   * `require`, plus: **somebody holds this thread** (TAR-186).
   *
   * The check every write into a conversation makes — the send, the internal
   * note and the status change — and the one a read does not. An unclaimed
   * conversation is visible to every agent on the tenant, which is what a shared
   * inbox is for; letting all of them write to it is how two agents answer the
   * same customer twice, and no idempotency key can catch that because each of
   * them sends a distinct request.
   *
   * So the shared pool is a queue, not a workspace: claiming
   * (`POST /conversations/{id}/claim`) is the first action, and it is what makes
   * the thread writable.
   *
   * **By one person, or by one team.** A conversation routed to a team is held,
   * so its members may all write to it — and two of them can still answer the
   * same customer. That is a narrower failure than the anonymous pool's: a
   * supervisor or a rule put the thread in front of that team deliberately, and
   * they can see each other. This rule does not close it, and closing it belongs
   * with the routing that creates it (TAR-23/24) rather than here.
   *
   * Uniform across roles rather than a supervisor exemption. A supervisor
   * replying into the pool produces the same double answer, they hold
   * `conversation:assign` and can take the thread in the same click, and a
   * `if (role === …)` here is the branch `rbac.ts` exists to forbid.
   *
   * Not applied to `markRead`: reading the pool is allowed, so recording that
   * somebody read it must be too, and an unread count is the thread's rather
   * than anybody's — nothing reaches the customer and nothing conflicts.
   */
  async requireHeld(conversationId: string): Promise<ConversationRow> {
    const conversation = await this.require(conversationId);

    if (isUnclaimed(conversation)) {
      throw new ConversationUnclaimedError(conversationId);
    }

    return conversation;
  }
}

/**
 * The requested order as the direction the query and its keyset both take.
 * A record rather than a ternary so a third sort cannot be added to the
 * contract without this failing to compile.
 */
const SORT_DIRECTIONS: Record<ConversationSort, 'asc' | 'desc'> = {
  newest: 'desc',
  oldest: 'asc',
};

/**
 * "Strictly after the cursor row in `(last_message_at, id)`", in the shape 0002
 * rules: an inclusive bound on the leading column, which the index serves as a
 * start condition, minus the part of that timestamp's tie group already
 * returned. `timestamp-keyset.ts` holds the reasoning and the two other lists
 * that share it.
 *
 * `direction` must be the one the `orderBy` uses. A cursor read in the opposite
 * direction returns the rows *before* the boundary rather than after it, which
 * is a page that silently repeats itself — hence one parameter feeding both,
 * rather than a literal here and another in the query.
 */
function resumeFrom(
  cursor: TimestampCursor,
  direction: 'asc' | 'desc',
): Prisma.ConversationWhereInput {
  const { bound, exclude } = resumeAfter(cursor, direction);

  return { lastMessageAt: bound, NOT: { lastMessageAt: cursor.at, ...exclude } };
}

/**
 * `q` against the contact, which is what an agent is actually searching for —
 * "the thread with Maria", "the one from +9665…". Searching message bodies is a
 * different feature with a different index and its own privacy question, and
 * the contract's one-line `q` does not ask for it.
 *
 * `insensitive` on the name; the phone is E.164 and has no case, so it is a
 * plain `contains` — which also lets a partial number match a suffix, the way
 * somebody reading a number off a screen types it.
 */
function contactSearch(q: string): Prisma.ContactWhereInput {
  return {
    OR: [{ displayName: { contains: q, mode: 'insensitive' } }, { phoneE164: { contains: q } }],
  };
}
