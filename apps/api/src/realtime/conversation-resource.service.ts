import { Inject, Injectable } from '@nestjs/common';
import type { ConversationResponse } from '@whatsappcrm/contracts';
import {
  CONVERSATION_PROJECTION,
  toConversationResponse,
} from '../conversations/conversation.mapper';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

/**
 * Turning a conversation id into the resource a socket publishes (TAR-198).
 *
 * `MessageResourceService`'s reasoning, applied to the other resource the
 * realtime contract carries whole. The domain event says what happened; the wire
 * event carries a full `ConversationResponse` (TAR-39, realtime: "payloads are
 * whole resources, not deltas"), including the preview, the unread count and the
 * active ticket that a handover event has no business restating. One indexed read
 * is what buys a client that can render the change without a refetch.
 *
 * `CONVERSATION_PROJECTION` and `toConversationResponse` are TAR-68's, imported
 * rather than restated, so `GET /conversations/{id}` and a relayed
 * `conversation.updated` publish the same thread identically. That import crosses
 * a layer — this is an L1 platform module and `conversations` is an L3 domain one
 * — and is the same category of sharing `MessageResourceService` documents at
 * length: a pure function and a projection constant, no provider, no injection,
 * no module edge.
 *
 * ## No origin, and therefore no hostname
 *
 * Unlike a message, a `ConversationResponse` carries no absolute URL back to this
 * API, so nothing here needs `ResponseOriginService` and the relay does not have
 * to publish a hostname before calling it. Worth stating because it is the one
 * asymmetry between the two resource readers: the day this response gains an
 * absolute URL — a contact avatar is the obvious candidate — this needs
 * `TenantHostnameService.publish()` in front of it exactly as the message path
 * does, and the mapper would otherwise throw rather than publish a wrong host.
 *
 * ## Isolation
 *
 * `TenantPrisma` under the scope the relay opened from the event's own tenant id,
 * so a conversation id that somehow named another tenant's row resolves to
 * nothing rather than to a payload. There is no principal in that scope and no
 * visibility check here on purpose: *who* may see this is decided by the rooms
 * the relay addresses, from the assignment on the row this read returns.
 */
@Injectable()
export class ConversationResourceService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  /**
   * The conversation as the API publishes it, or `null` when the row is gone.
   *
   * `null` is a race with a legitimate outcome rather than an error to shout
   * about — a thread deleted between the commit that emitted the event and this
   * read — and the honest response to it is to relay nothing.
   */
  async findForRelay(conversationId: string): Promise<ConversationResponse | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: CONVERSATION_PROJECTION,
    });

    return conversation === null ? null : toConversationResponse(conversation);
  }
}
