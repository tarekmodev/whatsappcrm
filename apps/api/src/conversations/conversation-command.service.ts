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
import { claimableFilter } from '../rbac/visibility';
import {
  CONVERSATION_PROJECTION,
  toConversationResponse,
  type ConversationRow,
} from './conversation.mapper';
import { ConversationQueryService } from './conversation-query.service';
import {
  ConversationAlreadyClaimedError,
  ConversationNotFoundError,
  UnknownTenantMemberError,
} from './conversations.errors';

/**
 * The four writes that change a conversation without sending anything: its
 * status, who owns it, taking one nobody owns, and whether it is still unread.
 *
 * Every one of them goes through `ConversationQueryService.require` first, so
 * the visibility rule is applied exactly once and a route cannot be the one that
 * forgets it. A conversation the principal may not see answers `not_found` here
 * as it does on a read — never `forbidden`, which would confirm the id names a
 * real thread.
 *
 * `setStatus` goes one further and uses `requireHeld`, because resolving a
 * thread nobody has claimed is the same shared-pool conflict a duplicate reply
 * is: two agents closing the same arriving conversation out from under each
 * other. `assign` and `markRead` deliberately do not — routing an unclaimed
 * thread is the whole point of the first, and the second reaches nobody.
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
    await this.conversations.requireHeld(conversationId);

    return this.write(conversationId, { status });
  }

  /**
   * `POST /conversations/{id}/claim` — an agent taking a thread out of the
   * shared pool, which is what makes it writable (TAR-186).
   *
   * ## Compare-and-set, because two agents are looking at the same row
   *
   * The whole failure this closes is a race: `scope=unassigned` shows the same
   * arriving conversation to every agent on the tenant, and a read-then-write
   * would let two of them both succeed and both believe they hold it. The
   * assignment therefore goes in as an `updateMany` carrying `claimableFilter()`
   * in its `WHERE`, so exactly one of two concurrent claims updates a row and
   * the other matches nothing. The database decides, not the order two requests
   * happened to arrive in.
   *
   * Bounded to records nobody is on by that predicate rather than by the
   * permission. Taking a thread off the colleague working it is a different act
   * with a different right (`conversation:assign`) and a confirmation in front
   * of it; this one can never do that, whatever it is called with. The other
   * bound is the visibility check above: a conversation routed to a team the
   * caller is not in answers `not_found` before the update is reached.
   *
   * ## Re-claiming what you already hold is a no-op, not a conflict
   *
   * A double-clicked button and a retry after a dropped response both arrive as
   * a second claim. Answering the second with 409 would tell an agent who does
   * hold the thread that they do not. So a claim that matched nothing re-reads
   * the row and reports a conflict only when somebody *else* is on it.
   *
   * ## Losing has two answers, and both are refusals
   *
   * `conflict` when the visibility read above still admitted the thread — the
   * caller was looking at the shared pool and the compare-and-set is what
   * refused them. `not_found` when the winner committed *first*, because the
   * thread is theirs by then and invisible to everyone else, which is what every
   * other route answers for it. Which one a losing caller sees is therefore a
   * matter of microseconds, and the console treats them the same way: refetch.
   * The alternative — reporting the conflict from a read that bypassed
   * visibility — is the id-enumeration this module refuses everywhere else.
   */
  async claim(conversationId: string): Promise<ConversationResponse> {
    // The row before the write, for the same reason `assign` loads one: it is
    // what the hand-over event carries, and `require` has to read it anyway.
    const before = await this.conversations.require(conversationId);
    const { userId } = this.tenantContext.requirePrincipal();

    const { count } = await this.prisma.conversation.updateMany({
      where: { id: conversationId, ...claimableFilter() },
      data: { assignedUserId: userId },
    });

    if (count === 0) {
      return this.reportLostClaim(conversationId, userId);
    }

    const claimed = toConversationResponse(await this.read(conversationId));

    this.announceHandover(before, claimed);

    return claimed;
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
   * The conversation as it stands, in the projection every response is built
   * from. Used where the write was an `updateMany` — which returns a count
   * rather than a row — so a compare-and-set still answers with the same shape
   * an `update` would have.
   */
  private async read(conversationId: string): Promise<ConversationRow> {
    return this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: CONVERSATION_PROJECTION,
    });
  }

  /**
   * What a claim that matched no row means, which is one of three things.
   *
   * The re-read is deliberately not `require`: by now the winner holds the
   * thread, so it is out of this principal's shared-pool visibility and
   * `require` would answer `not_found` — telling an agent who was looking at the
   * conversation a moment ago that it does not exist. RLS still scopes the read
   * to the tenant, and the caller already saw this id in the queue, so reporting
   * the conflict leaks nothing they did not have.
   */
  private async reportLostClaim(
    conversationId: string,
    userId: string,
  ): Promise<ConversationResponse> {
    const current = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: CONVERSATION_PROJECTION,
    });

    if (current === null) {
      // Deleted, or another tenant's — `require` admitted it a moment ago, so
      // this is a race with a delete rather than an enumeration attempt.
      throw new ConversationNotFoundError(conversationId);
    }

    if (current.assignedUserId === userId) {
      // Already theirs: a double-click, or a retry after a dropped response.
      return toConversationResponse(current);
    }

    throw new ConversationAlreadyClaimedError(conversationId);
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
