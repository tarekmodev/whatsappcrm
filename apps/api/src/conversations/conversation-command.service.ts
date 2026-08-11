import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  ConversationAssignInput,
  ConversationResponse,
  ConversationStatus,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  CONVERSATION_ASSIGNED_EVENT,
  type ConversationAssignedEvent,
} from '../events/domain-events';
import type { Prisma } from '../generated/prisma/client';
import { UserStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  CONVERSATION_PROJECTION,
  toConversationResponse,
  type ConversationRow,
} from './conversation.mapper';
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
    private readonly tenantContext: TenantContextService,
    private readonly events: EventEmitter2,
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
   *
   * It is the one command here that changes **who may see the thread**, which is
   * why it is also the one that announces itself (TAR-198): every other agent's
   * inbox is showing a row whose owner just changed, and only an event gets that
   * onto their screen without a refetch.
   */
  async assign(
    conversationId: string,
    input: ConversationAssignInput,
  ): Promise<ConversationResponse> {
    // `require` already loads the row the visibility check needs, which is the
    // same row that carries the assignment being replaced — so the previous
    // owner costs no extra query.
    const before = await this.conversations.require(conversationId);
    await this.assertAssigneesExist(input);

    const assigned = await this.write(conversationId, {
      ...(input.userId === undefined ? {} : { assignedUserId: input.userId }),
      ...(input.teamId === undefined ? {} : { assignedTeamId: input.teamId }),
    });

    this.announceHandover(before, assigned);

    return assigned;
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
   * Tells the realtime relay a thread changed hands, so the colleagues watching
   * it find out now rather than on their next unrelated event.
   *
   * ## After the write, and never in front of the response
   *
   * `write` is a single statement, so by the time this runs the new owner is
   * committed — pushing a hand-over that a rollback then un-wrote is the failure
   * every other producer of these events avoids the same way. It is fire and
   * forget on the in-process bus: `emit` is synchronous dispatch and the
   * subscriber catches its own failures, so a relay that cannot reach Redis costs
   * a client one refetch rather than failing the claim that already happened.
   *
   * ## Silent when nothing moved
   *
   * Re-assigning a thread to the agent who already holds it is a no-op, and a
   * relay for it would be a broadcast of nothing — including to the agent's own
   * tab, which would then re-render a row that did not change. The comparison is
   * against the row `require` loaded rather than against the input, because the
   * input's three cases (absent, `null`, an id) do not say by themselves whether
   * a column moved.
   */
  private announceHandover(before: ConversationRow, after: ConversationResponse): void {
    if (
      before.assignedUserId === after.assignedUserId &&
      before.assignedTeamId === after.assignedTeamId
    ) {
      return;
    }

    const event: ConversationAssignedEvent = {
      tenantId: this.tenantContext.requireTenantId(),
      conversationId: after.id,
      previousAssignedUserId: before.assignedUserId,
      previousAssignedTeamId: before.assignedTeamId,
    };

    this.events.emit(CONVERSATION_ASSIGNED_EVENT, event);
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
