import { Inject, Injectable } from '@nestjs/common';
import type { ConversationAudience, MessageResponse } from '@whatsappcrm/contracts';
import { ResponseOriginService } from '../common/response-origin.service';
import { MESSAGE_PROJECTION, toMessageResponse } from '../conversations/message.mapper';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

/**
 * Turning a message id into the resource a socket publishes.
 *
 * ## Why the relay reads the row back at all
 *
 * The domain event carries what the emitter happened to have in hand, and says
 * so — it is explicitly not an API contract. What goes on the wire is a full
 * `MessageResponse` (TAR-39, realtime: "payloads are whole resources, not
 * deltas"), including the attachments the event does not mention and the
 * timestamps it does not carry. One indexed read per relayed message is what
 * buys a client that can render the event without a refetch, which is the entire
 * point of the payload rule.
 *
 * The read runs on `TenantPrisma` inside the scope the relay opened from the
 * event's own tenant id, so a message id that somehow named another tenant's row
 * resolves to nothing rather than to a payload.
 *
 * ## The projection and the mapper are TAR-68's, not a second copy
 *
 * `MESSAGE_PROJECTION` and `toMessageResponse` come from
 * `conversations/message.mapper.ts`, so `GET /conversations/{id}/messages` and a
 * relayed `message.created` publish the same message identically. A second
 * mapper would be a second answer to "is a `received` row `delivered`" and to
 * "does a placeholder count as automation", and the two would drift the first
 * time either question was revisited — which is the failure `rbac/visibility.ts`
 * documents for its own rule.
 *
 * That import crosses a layer: this is an L1 platform module and that is an L3
 * domain one. It is a **pure function and a projection constant** — no
 * provider, no injection, no module edge, so nothing in the module graph points
 * the wrong way and `RealtimeModule` still imports nothing. It is the same
 * category of sharing as `events/domain-events.ts`, which lives outside every
 * feature module precisely so an L1 subscriber and an L2 emitter can share a
 * shape without either importing the other. The honest follow-up, once a third
 * caller wants it, is to move the mapper somewhere neutral the way that file
 * already is.
 */
@Injectable()
export class MessageResourceService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly origin: ResponseOriginService,
  ) {}

  /**
   * The message as the API publishes it and the audience allowed to see it, or
   * `null` when the row is gone.
   *
   * `null` is not an error the relay should shout about: a message deleted
   * between the commit that emitted the event and this read is a race with a
   * legitimate outcome, and the honest response is to relay nothing.
   *
   * The conversation's assignment is read in the **same statement** as the
   * message, and that pairing is deliberate: the audience has to be the one that
   * applied to the row being published, and two queries would leave a window in
   * which a thread changes hands between deciding what to send and deciding who
   * may see it. It costs nothing extra — `messages` is joined to its
   * conversation on `(tenant_id, conversation_id)`, which is the leading edge of
   * the index the thread view already uses.
   *
   * Requires a hostname in scope as well as a tenant — `ResponseOriginService`
   * refuses to invent one — which is what `TenantHostnameService` puts there
   * before this is called.
   */
  async findForRelay(messageId: string): Promise<RelayableMessage | null> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        ...MESSAGE_PROJECTION,
        tenantId: true,
        conversation: { select: { assignedUserId: true, assignedTeamId: true } },
      },
    });

    if (message === null) {
      return null;
    }

    return {
      message: toMessageResponse(message, this.origin.require()),
      audience: {
        tenantId: message.tenantId,
        assignedUserId: message.conversation.assignedUserId,
        assignedTeamId: message.conversation.assignedTeamId,
      },
    };
  }
}

/** A message, and who may currently be shown it. */
export interface RelayableMessage {
  readonly message: MessageResponse;
  readonly audience: ConversationAudience;
}
