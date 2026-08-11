import { Inject, Injectable } from '@nestjs/common';
import type {
  ConversationAssignInput,
  ConversationResponse,
  ConversationStatus,
} from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { UserStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { CONVERSATION_PROJECTION, toConversationResponse } from './conversation.mapper';
import { ConversationQueryService } from './conversation-query.service';
import { UnknownTenantMemberError } from './conversations.errors';

/**
 * The three writes that change a conversation without sending anything: its
 * status, who owns it, and whether it is still unread.
 *
 * Every one of them goes through `ConversationQueryService.require` first, so
 * the visibility rule is applied exactly once and a route cannot be the one that
 * forgets it. A conversation the principal may not see answers `not_found` here
 * as it does on a read — never `forbidden`, which would confirm the id names a
 * real thread.
 *
 * ## Not audited, deliberately
 *
 * `audit_logs` carries security-relevant events — role changes, invites, session
 * revocation, provisioning, credentials. Assigning a conversation or resolving
 * one is ordinary operational activity: it happens hundreds of times a day per
 * tenant, and writing it here would drown the trail an auditor actually reads.
 * The per-thread history an operator wants is `ticket_events` (TAR-32), which is
 * that story's to extend to conversations if the product asks for it.
 */
@Injectable()
export class ConversationCommandService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly conversations: ConversationQueryService,
  ) {}

  /**
   * `PATCH /conversations/{id}/status`.
   *
   * Every transition is allowed, including re-opening a closed thread: a
   * customer writing back is the common case, and refusing it would leave an
   * agent with a finished conversation and a live customer. The state machine
   * that *does* constrain transitions is the ticket's (0003), which is a
   * different entity with a different lifecycle.
   */
  async setStatus(
    conversationId: string,
    status: ConversationStatus,
  ): Promise<ConversationResponse> {
    await this.conversations.require(conversationId);

    return this.write(conversationId, { status });
  }

  /**
   * `POST /conversations/{id}/assign` — the claim.
   *
   * Both fields are optional and either may be `null`, and the three cases are
   * distinct on purpose: absent leaves the column alone, `null` clears it, and
   * an id sets it. That is what lets one endpoint move a thread from an agent to
   * a team, hand it to a named agent inside a team, and release it back to the
   * shared pool — without a second route per direction.
   *
   * Releasing both is what puts a conversation back in `scope=unassigned`, where
   * every agent can see it again.
   */
  async assign(
    conversationId: string,
    input: ConversationAssignInput,
  ): Promise<ConversationResponse> {
    await this.conversations.require(conversationId);
    await this.assertAssigneesExist(input);

    return this.write(conversationId, {
      ...(input.userId === undefined ? {} : { assignedUserId: input.userId }),
      ...(input.teamId === undefined ? {} : { assignedTeamId: input.teamId }),
    });
  }

  /**
   * `POST /conversations/{id}/read` — 204, and idempotent.
   *
   * A blunt reset to zero rather than a decrement: the count answers "is there
   * anything here I have not seen", the agent has just opened the thread, and a
   * decrement would need a per-agent read cursor this product does not have. In
   * a shared inbox the count is the *thread's*, not the reader's — which is the
   * honest model when two agents are looking at the same conversation.
   */
  async markRead(conversationId: string): Promise<void> {
    await this.conversations.require(conversationId);

    await this.prisma.conversation.updateMany({
      where: { id: conversationId },
      data: { unreadCount: 0 },
    });
  }

  /**
   * The update every command shares, reading back exactly the projection the
   * response is built from — so a mutation and a read of the same conversation
   * cannot publish different shapes.
   */
  private async write(
    conversationId: string,
    // The `Unchecked` variant, which is the one that takes the foreign-key
    // columns as scalars. The checked shape wants `assignedUser: { connect }`,
    // and a connect names `(tenant_id, id)` — so it would put the tenant id back
    // into a statement that has no business naming one, when RLS is what
    // supplies it.
    data: Prisma.ConversationUncheckedUpdateInput,
  ): Promise<ConversationResponse> {
    return toConversationResponse(
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data,
        select: CONVERSATION_PROJECTION,
      }),
    );
  }

  /**
   * Refuses an assignee this tenant does not have.
   *
   * The foreign keys would refuse a stranger's id anyway — RLS makes another
   * tenant's user invisible, and the composite key is `(tenant_id, id)` — but
   * as a driver error and a 500. Checking here turns it into the
   * `validation_failed` naming the offending field that the caller can act on.
   *
   * `active` only: a removed account cannot answer, and a suspended one has had
   * its access cut, so routing live customer conversations to either is work
   * that silently goes nowhere. An `invited` user has not accepted yet and has
   * no session to read the thread with.
   */
  private async assertAssigneesExist(input: ConversationAssignInput): Promise<void> {
    if (typeof input.userId === 'string') {
      const user = await this.prisma.user.findUnique({
        where: { id: input.userId, status: UserStatus.active },
        select: { id: true },
      });

      if (user === null) {
        throw new UnknownTenantMemberError('userId', 'user', input.userId);
      }
    }

    if (typeof input.teamId === 'string') {
      const team = await this.prisma.team.findUnique({
        where: { id: input.teamId },
        select: { id: true },
      });

      if (team === null) {
        throw new UnknownTenantMemberError('teamId', 'team', input.teamId);
      }
    }
  }
}
